/**
 * Statistics, leaderboards, profiles and awards (spec §64-§74).
 *
 * Two rules shape everything here:
 *   - "Average Odds" is ALWAYS computed by averaging decimal odds and
 *     converting back, matching the group's established spreadsheet method
 *     (spec §65). The helper in @fcp/shared is the only implementation.
 *   - Statistics are descriptive. Nothing here claims predictive power (spec §73).
 */
import { prisma } from '../lib/prisma.js';
import {
  averageAmericanOdds,
  impliedProbability,
  hypotheticalProfit,
  americanToDecimal,
  type LegResult,
} from '@fcp/shared';

export interface BettorRecord {
  userId: string | null;
  displayName: string;
  wins: number;
  losses: number;
  pushes: number;
  total: number;
  winPct: number | null;
  averageOdds: number | null;
  averageImpliedProbability: number | null;
  plusMoneyShare: number | null;
  wagered: number;
  returned: number;
  profit: number;
  roi: number | null;
  currentStreak: { kind: 'W' | 'L' | null; length: number };
  longestWinStreak: number;
  longestLosingStreak: number;
}

interface PickLike {
  bettorName: string;
  userId: string | null;
  americanOdds: number;
  result: LegResult;
  seasonYear: number;
  weekNumber: number;
  pickText: string;
  matchupText: string | null;
  outcomeText: string | null;
}

/**
 * Load every settled pick, historical and live, as one comparable series.
 * Official ticket odds drive the record once a ticket exists (spec §58, §66).
 */
export async function loadAllPicks(opts: { seasonYear?: number; userId?: string } = {}): Promise<PickLike[]> {
  const historical = await prisma.historicalPick.findMany({
    where: {
      ...(opts.seasonYear ? { seasonYear: opts.seasonYear } : {}),
      ...(opts.userId ? { userId: opts.userId } : {}),
      result: { in: ['WIN', 'LOSS', 'PUSH', 'VOID'] },
    },
    orderBy: [{ seasonYear: 'asc' }, { weekNumber: 'asc' }],
  });

  const live = await prisma.officialTicketLeg.findMany({
    where: {
      result: { in: ['WIN', 'LOSS', 'PUSH', 'VOID'] },
      ticket: { status: 'CONFIRMED' },
      ...(opts.userId ? { userId: opts.userId } : {}),
    },
    include: {
      user: true,
      ticket: { include: { week: { include: { season: true } } } },
      pick: { include: { nflGame: { include: { homeTeam: true, awayTeam: true } } } },
    },
  });

  const rows: PickLike[] = historical.map((h) => ({
    bettorName: h.bettorName,
    userId: h.userId,
    americanOdds: h.americanOdds,
    result: h.result as LegResult,
    seasonYear: h.seasonYear,
    weekNumber: h.weekNumber,
    pickText: h.pickText,
    matchupText: h.matchupText,
    outcomeText: h.outcomeText,
  }));

  for (const leg of live) {
    if (leg.americanOdds === null || !leg.user) continue;
    const seasonYear = leg.ticket.week.season.year;
    if (opts.seasonYear && seasonYear !== opts.seasonYear) continue;
    rows.push({
      bettorName: leg.user.displayName,
      userId: leg.userId,
      americanOdds: leg.americanOdds,
      result: leg.result as LegResult,
      seasonYear,
      weekNumber: leg.ticket.week.weekNumber,
      pickText: leg.descriptionText,
      matchupText: leg.pick ? `${leg.pick.nflGame.awayTeam.nickname} @ ${leg.pick.nflGame.homeTeam.nickname}` : null,
      outcomeText: leg.resultNarrative,
    });
  }

  return rows.sort((a, b) => a.seasonYear - b.seasonYear || a.weekNumber - b.weekNumber);
}

export function summarize(picks: PickLike[], displayName: string, userId: string | null): BettorRecord {
  const wins = picks.filter((p) => p.result === 'WIN').length;
  const losses = picks.filter((p) => p.result === 'LOSS').length;
  const pushes = picks.filter((p) => p.result === 'PUSH' || p.result === 'VOID').length;
  const decided = wins + losses;

  const odds = picks.map((p) => p.americanOdds).filter((o) => Number.isFinite(o) && (o <= -100 || o >= 100));
  const money = hypotheticalProfit(picks.map((p) => ({ odds: p.americanOdds, result: p.result })));

  // Streaks run in chronological order and ignore pushes.
  let longestWin = 0, longestLoss = 0, runWin = 0, runLoss = 0;
  let currentKind: 'W' | 'L' | null = null, currentLength = 0;
  for (const p of picks) {
    if (p.result === 'WIN') {
      runWin += 1; runLoss = 0;
      longestWin = Math.max(longestWin, runWin);
      currentKind = 'W'; currentLength = runWin;
    } else if (p.result === 'LOSS') {
      runLoss += 1; runWin = 0;
      longestLoss = Math.max(longestLoss, runLoss);
      currentKind = 'L'; currentLength = runLoss;
    }
  }

  const implied = odds.map(impliedProbability);

  return {
    userId,
    displayName,
    wins,
    losses,
    pushes,
    total: picks.length,
    winPct: decided === 0 ? null : wins / decided,
    averageOdds: averageAmericanOdds(odds),
    averageImpliedProbability: implied.length ? implied.reduce((a, b) => a + b, 0) / implied.length : null,
    plusMoneyShare: odds.length ? odds.filter((o) => o > 0).length / odds.length : null,
    wagered: money.wagered,
    returned: money.returned,
    profit: money.profit,
    roi: money.roi,
    currentStreak: { kind: currentKind, length: currentLength },
    longestWinStreak: longestWin,
    longestLosingStreak: longestLoss,
  };
}

/** Leaderboard for a season, or all time when seasonYear is omitted (spec §69). */
export async function leaderboard(seasonYear?: number): Promise<BettorRecord[]> {
  const picks = await loadAllPicks({ seasonYear });
  const byBettor = new Map<string, PickLike[]>();
  for (const p of picks) {
    const key = p.bettorName;
    if (!byBettor.has(key)) byBettor.set(key, []);
    byBettor.get(key)!.push(p);
  }

  const records = [...byBettor.entries()].map(([name, rows]) => summarize(rows, name, rows[0].userId));
  return records.sort((a, b) => {
    if ((b.winPct ?? 0) !== (a.winPct ?? 0)) return (b.winPct ?? 0) - (a.winPct ?? 0);
    return b.wins - a.wins;
  });
}

/** Full bettor profile with breakdowns (spec §68). */
export async function bettorProfile(displayName: string) {
  const all = await loadAllPicks();
  const mine = all.filter((p) => p.bettorName.toLowerCase() === displayName.toLowerCase());
  if (mine.length === 0) return null;

  const seasons = [...new Set(mine.map((p) => p.seasonYear))].sort();
  const bySeason = seasons.map((year) => summarize(mine.filter((p) => p.seasonYear === year), displayName, mine[0].userId));

  return {
    displayName,
    allTime: summarize(mine, displayName, mine[0].userId),
    bySeason: Object.fromEntries(seasons.map((y, i) => [y, bySeason[i]])),
    byMarket: groupBy(mine, (p) => marketBucket(p.pickText)),
    byTeam: groupBy(mine, (p) => teamBucket(p.pickText)),
    byOddsRange: groupBy(mine, (p) => oddsBucket(p.americanOdds)),
    favouriteVsUnderdog: groupBy(mine, (p) => (p.americanOdds < 0 ? 'Favorite' : 'Underdog')),
    recent: mine.slice(-15).reverse(),
  };
}

function groupBy(picks: PickLike[], keyOf: (p: PickLike) => string) {
  const map = new Map<string, PickLike[]>();
  for (const p of picks) {
    const k = keyOf(p);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(p);
  }
  return [...map.entries()]
    .map(([label, rows]) => {
      const wins = rows.filter((r) => r.result === 'WIN').length;
      const losses = rows.filter((r) => r.result === 'LOSS').length;
      return {
        label,
        wins,
        losses,
        total: rows.length,
        winPct: wins + losses === 0 ? null : wins / (wins + losses),
        averageOdds: averageAmericanOdds(rows.map((r) => r.americanOdds)),
      };
    })
    .sort((a, b) => b.total - a.total);
}

/** Classify a free-text historical pick into a market family (spec §68). */
export function marketBucket(pickText: string): string {
  const t = pickText.toLowerCase();
  if (t.includes('moneyline')) return 'Moneyline';
  if (/[+-]\d+(\.\d+)?\s*$/.test(pickText.trim()) || t.includes('spread')) return 'Spread';
  if (t.includes('total') || t.includes('over') || t.includes('under')) {
    if (t.includes('rec') ) return 'Receiving Prop';
    if (t.includes('rush')) return 'Rushing Prop';
    if (t.includes('pass')) return 'Passing Prop';
    if (t.includes('fg') || t.includes('field goal')) return 'Kicking Prop';
    return 'Total';
  }
  if (t.includes('atd') || t.includes('touchdown') || t.includes(' td')) return 'Touchdown';
  if (t.includes('rec')) return 'Receiving Prop';
  if (t.includes('rush')) return 'Rushing Prop';
  if (t.includes('pass')) return 'Passing Prop';
  return 'Other';
}

function teamBucket(pickText: string): string {
  const first = pickText.trim().split(/\s+/)[0];
  return first || 'Unknown';
}

export function oddsBucket(odds: number): string {
  if (odds <= -200) return '-200 or shorter';
  if (odds <= -150) return '-199 to -150';
  if (odds <= -100) return '-149 to -100';
  if (odds < 150) return '+100 to +149';
  if (odds < 200) return '+150 to +199';
  return '+200 or longer';
}

/** Group-wide parlay statistics (spec §72). */
export async function groupParlayStats() {
  const parlays = await prisma.parlay.findMany({ where: { settled: true }, include: { week: { include: { season: true } } } });
  const weeksOff = await prisma.nFLWeek.count({ where: { status: 'WEEK_OFF' } });

  const wagered = parlays.reduce((s, p) => s + Number(p.wagerAmount ?? 0), 0);
  const returned = parlays.filter((p) => p.won).reduce((s, p) => s + Number(p.potentialPayout ?? 0), 0);
  const legsWon = parlays.map((p) => p.legsWon);

  return {
    totalParlays: parlays.length,
    weeksOff,
    parlaysWon: parlays.filter((p) => p.won).length,
    parlaysLost: parlays.filter((p) => p.won === false).length,
    amountWagered: wagered,
    totalReturn: returned,
    netProfit: returned - wagered,
    roi: wagered === 0 ? null : (returned - wagered) / wagered,
    averageCombinedOdds: averageAmericanOdds(
      parlays.map((p) => p.combinedAmericanOdds).filter((o): o is number => o !== null),
    ),
    averageLegsWon: legsWon.length ? legsWon.reduce((a, b) => a + b, 0) / legsWon.length : null,
    tenOfTenWeeks: parlays.filter((p) => p.legsWon === 10).length,
    nineOfTenWeeks: parlays.filter((p) => p.legsWon === 9).length,
    eightOfTenWeeks: parlays.filter((p) => p.legsWon === 8).length,
    bestWeek: parlays.length ? Math.max(...legsWon) : null,
    worstWeek: parlays.length ? Math.min(...legsWon) : null,
  };
}

/** Descriptive group tendencies (spec §73). Never framed as prediction. */
export async function groupTendencies(seasonYear?: number) {
  const picks = await loadAllPicks({ seasonYear });
  const byMarket = groupBy(picks, (p) => marketBucket(p.pickText));
  const notes = byMarket
    .filter((m) => m.total >= 10 && m.winPct !== null)
    .sort((a, b) => (b.winPct ?? 0) - (a.winPct ?? 0))
    .slice(0, 5)
    .map((m) => ({
      label: m.label,
      text: `${m.label} selections have won ${m.wins} of ${m.wins + m.losses} (${Math.round((m.winPct ?? 0) * 100)}%) across ${m.total} picks.`,
      sampleSize: m.total,
    }));

  return {
    disclaimer: 'These figures describe what has already happened. They do not predict future results.',
    byMarket,
    byOddsRange: groupBy(picks, (p) => oddsBucket(p.americanOdds)),
    notes,
  };
}

/**
 * Early-pick value: how the locked price compared with the official ticket
 * price (spec §74). Informational only.
 */
export async function earlyPickValue(seasonYear?: number) {
  const legs = await prisma.officialTicketLeg.findMany({
    where: {
      ticket: { status: 'CONFIRMED', ...(seasonYear ? { week: { season: { year: seasonYear } } } : {}) },
      pickId: { not: null },
      americanOdds: { not: null },
    },
    include: { user: true, pick: true },
  });

  const byUser = new Map<string, { locked: number[]; official: number[] }>();
  for (const leg of legs) {
    if (!leg.user || leg.pick?.lockedAmericanOdds == null || leg.americanOdds == null) continue;
    const key = leg.user.displayName;
    if (!byUser.has(key)) byUser.set(key, { locked: [], official: [] });
    byUser.get(key)!.locked.push(leg.pick.lockedAmericanOdds);
    byUser.get(key)!.official.push(leg.americanOdds);
  }

  return [...byUser.entries()]
    .map(([displayName, v]) => {
      const avgLocked = averageAmericanOdds(v.locked);
      const avgOfficial = averageAmericanOdds(v.official);
      const impliedShift =
        avgLocked !== null && avgOfficial !== null
          ? (impliedProbability(avgOfficial) - impliedProbability(avgLocked)) * 100
          : null;
      return {
        displayName,
        sampleSize: v.locked.length,
        averageLockedOdds: avgLocked,
        averageOfficialOdds: avgOfficial,
        // Negative means the price drifted longer after locking: good early value.
        impliedProbabilityPointsShift: impliedShift,
      };
    })
    .sort((a, b) => (a.impliedProbabilityPointsShift ?? 0) - (b.impliedProbabilityPointsShift ?? 0));
}

/** Season and all-time awards (spec §71). Entertainment, not guarantees. */
export async function seasonAwards(seasonYear?: number) {
  const board = await leaderboard(seasonYear);
  if (board.length === 0) return [];
  const qualified = board.filter((b) => b.total >= 5);
  const pool = qualified.length ? qualified : board;

  const best = (key: keyof BettorRecord, dir: 1 | -1) =>
    [...pool].sort((a, b) => {
      const av = (a[key] as number | null) ?? (dir === 1 ? -Infinity : Infinity);
      const bv = (b[key] as number | null) ?? (dir === 1 ? -Infinity : Infinity);
      return dir === 1 ? bv - av : av - bv;
    })[0];

  const awards = [
    { awardKey: 'SEASON_BEST_HANDICAPPER', label: 'Best Handicapper', winner: best('winPct', 1), format: (r: BettorRecord) => `${r.wins}-${r.losses}` },
    { awardKey: 'SEASON_WORST_HANDICAPPER', label: 'Worst Handicapper', winner: best('winPct', -1), format: (r: BettorRecord) => `${r.wins}-${r.losses}` },
    { awardKey: 'BALLSIEST_BETTOR', label: 'Ballsiest Bettor', winner: best('averageImpliedProbability', -1), format: (r: BettorRecord) => `${Math.round((r.averageImpliedProbability ?? 0) * 100)}% average implied probability` },
    { awardKey: 'MOST_CONSERVATIVE', label: 'Most Conservative Bettor', winner: best('averageImpliedProbability', 1), format: (r: BettorRecord) => `${Math.round((r.averageImpliedProbability ?? 0) * 100)}% average implied probability` },
    { awardKey: 'BEST_ROI', label: 'Best ROI', winner: best('roi', 1), format: (r: BettorRecord) => `${((r.roi ?? 0) * 100).toFixed(1)}% on $10 a pick` },
    { awardKey: 'LONGEST_WIN_STREAK', label: 'Longest Win Streak', winner: best('longestWinStreak', 1), format: (r: BettorRecord) => `${r.longestWinStreak} in a row` },
    { awardKey: 'LONGEST_LOSING_STREAK', label: 'Longest Losing Streak', winner: best('longestLosingStreak', 1), format: (r: BettorRecord) => `${r.longestLosingStreak} in a row` },
    { awardKey: 'MR_PLUS_MONEY', label: 'Mr. Plus Money', winner: best('plusMoneyShare', 1), format: (r: BettorRecord) => `${Math.round((r.plusMoneyShare ?? 0) * 100)}% plus-money picks` },
  ];

  return awards
    .filter((a) => a.winner)
    .map((a) => ({
      awardKey: a.awardKey,
      label: a.label,
      winner: a.winner.displayName,
      detail: a.format(a.winner),
      seasonYear: seasonYear ?? null,
    }));
}

/** Weekly awards derived from a settled week (spec §70). */
export async function weeklyAwards(nflWeekId: string) {
  const legs = await prisma.officialTicketLeg.findMany({
    where: { ticket: { nflWeekId, status: 'CONFIRMED' }, result: { in: ['WIN', 'LOSS'] } },
    include: { user: true },
  });
  if (legs.length === 0) return [];

  const priced = legs.filter((l) => l.americanOdds !== null);
  const wins = priced.filter((l) => l.result === 'WIN');
  const losses = priced.filter((l) => l.result === 'LOSS');
  const withMargin = legs.filter((l) => l.margin !== null);

  const out: { awardKey: string; label: string; winner: string; detail: string }[] = [];
  const push = (awardKey: string, label: string, leg: (typeof legs)[number] | undefined, detail: string) => {
    if (leg?.user) out.push({ awardKey, label, winner: leg.user.displayName, detail });
  };

  const bestPick = [...wins].sort((a, b) => americanToDecimal(b.americanOdds!) - americanToDecimal(a.americanOdds!))[0];
  push('BEST_PICK', 'Best Pick', bestPick, bestPick ? `${bestPick.descriptionText} at ${bestPick.americanOdds}` : '');

  const worstPick = [...losses].sort((a, b) => americanToDecimal(a.americanOdds!) - americanToDecimal(b.americanOdds!))[0];
  push('WORST_PICK', 'Worst Pick', worstPick, worstPick ? `${worstPick.descriptionText} at ${worstPick.americanOdds}` : '');

  const riskiest = [...priced].sort((a, b) => impliedProbability(a.americanOdds!) - impliedProbability(b.americanOdds!))[0];
  push('RISKIEST_PICK', 'Riskiest Pick', riskiest, riskiest ? `${Math.round(impliedProbability(riskiest.americanOdds!) * 100)}% implied` : '');

  const safest = [...priced].sort((a, b) => impliedProbability(b.americanOdds!) - impliedProbability(a.americanOdds!))[0];
  push('SAFEST_PICK', 'Safest Pick', safest, safest ? `${Math.round(impliedProbability(safest.americanOdds!) * 100)}% implied` : '');

  const sweat = [...withMargin.filter((l) => l.result === 'WIN')].sort((a, b) => Number(a.margin) - Number(b.margin))[0];
  push('BIGGEST_SWEAT', 'Biggest Sweat', sweat, sweat ? sweat.resultNarrative ?? '' : '');

  const closest = [...withMargin.filter((l) => l.result === 'LOSS')].sort((a, b) => Number(b.margin) - Number(a.margin))[0];
  push('CLOSEST_MISS', 'Closest Miss', closest, closest ? closest.resultNarrative ?? '' : '');

  return out;
}
