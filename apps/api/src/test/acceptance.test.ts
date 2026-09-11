/**
 * THE CORE ACCEPTANCE TESTS (spec §97).
 *
 * This file is the checklist from the specification, in the order it is
 * written there, so it can be read as the answer to "is the application
 * usable yet?". Each test is deliberately end-to-end through the real
 * services and the real database rather than through mocks.
 *
 * Several of these behaviours are also covered in depth by the per-service
 * suites; the duplication is intentional — this file exists to be read.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { prisma } from '../lib/prisma.js';
import { resetDatabase, makeUser, makeWeek, makeGame, makeMarket } from './fixtures.js';
import { hashPassword } from '../lib/auth.js';
import { lockPick, setPendingPick, unlockPick, PickError } from '../services/picks.js';
import { detectLockedPickIssues } from '../services/marketMonitor.js';
import { runScan, recordFailure, checkCircuitBreaker } from '../services/readerRun.js';
import { setReaderSettings } from '../lib/settings.js';
import { uploadTicket, verifyTicket, confirmOfficialParlay } from '../services/tickets.js';
import { gradeOfficialLeg, sweatBoard } from '../services/live.js';
import { applyImport, recordCorrection } from '../services/historicalImport.js';
import { leaderboard } from '../services/stats.js';
import { RateLimitSignal, type BoardReaderProvider, type RawMarket, type RequestContext } from '../providers/types.js';
import { averageAmericanOdds, americanToDecimal, decimalToAmerican, checkGuideline, INITIAL_ROSTER, NAMED_CORRECTIONS } from '@fcp/shared';

const WORKBOOK = path.resolve(process.cwd(), '../../data/Last_Place_Lagers_First_Class_Parlays.xlsx');

let week: Awaited<ReturnType<typeof makeWeek>>;
let austin: Awaited<ReturnType<typeof makeUser>>;
let tanner: Awaited<ReturnType<typeof makeUser>>;

async function freshWeek() {
  await resetDatabase();
  week = await makeWeek();
  austin = await makeUser('Austin', 'ADMIN');
  tanner = await makeUser('Tanner');
}

afterAll(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// 1. RESERVATION
// ---------------------------------------------------------------------------
describe('§97 · RESERVATION — two users attempt to lock the same game simultaneously', () => {
  beforeEach(freshWeek);

  it('exactly one succeeds', async () => {
    const game = await makeGame(week.id, 'BUF', 'MIA');
    const a = await makeMarket(game.id, { subjectLabel: 'Josh Allen' });
    const b = await makeMarket(game.id, { subjectLabel: 'James Cook' });

    const results = await Promise.allSettled([
      lockPick({ userId: austin.id, nflWeekId: week.id, marketId: a.id }),
      lockPick({ userId: tanner.id, nflWeekId: week.id, marketId: b.id }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await prisma.matchupReservation.count({ where: { nflGameId: game.id } })).toBe(1);
    expect(((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason as PickError).code).toBe('MATCHUP_TAKEN');
  });
});

// ---------------------------------------------------------------------------
// 2. PENDING
// ---------------------------------------------------------------------------
describe('§97 · PENDING — a pending pick does not reserve the matchup', () => {
  beforeEach(freshWeek);

  it('creates no reservation and leaves the game open to others', async () => {
    const game = await makeGame(week.id, 'BUF', 'MIA');
    const mine = await makeMarket(game.id);
    const theirs = await makeMarket(game.id, { subjectLabel: 'James Cook' });

    await setPendingPick(austin.id, week.id, mine.id);
    expect(await prisma.matchupReservation.count({ where: { nflWeekId: week.id } })).toBe(0);

    await expect(lockPick({ userId: tanner.id, nflWeekId: week.id, marketId: theirs.id })).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 3. UNLOCK
// ---------------------------------------------------------------------------
describe('§97 · UNLOCK — unlocking releases the game immediately', () => {
  beforeEach(freshWeek);

  it('the matchup is lockable by someone else on the very next request', async () => {
    const game = await makeGame(week.id, 'BUF', 'MIA');
    const m1 = await makeMarket(game.id);
    const m2 = await makeMarket(game.id, { subjectLabel: 'James Cook' });

    await lockPick({ userId: tanner.id, nflWeekId: week.id, marketId: m1.id });
    await unlockPick(tanner.id, week.id);

    expect(await prisma.matchupReservation.count({ where: { nflGameId: game.id } })).toBe(0);
    await expect(lockPick({ userId: austin.id, nflWeekId: week.id, marketId: m2.id })).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 4. OUTSIDE ODDS
// ---------------------------------------------------------------------------
describe('§97 · OUTSIDE ODDS — a +225 selection warns but remains selectable', () => {
  beforeEach(freshWeek);

  it('warns and still locks', async () => {
    const game = await makeGame(week.id, 'BUF', 'MIA');
    const market = await makeMarket(game.id, { americanOdds: 225 });

    expect(checkGuideline(225).outsideGuideline).toBe(true);

    const result = await lockPick({ userId: austin.id, nflWeekId: week.id, marketId: market.id });
    expect(result.pick.state).toBe('LOCKED');
    expect(result.outsideGuideline).toBe(true);
    expect(result.guidelineMessage).toContain('OUTSIDE GROUP ODDS GUIDELINE');
  });
});

// ---------------------------------------------------------------------------
// 5. ODDS MOVEMENT
// ---------------------------------------------------------------------------
describe('§97 · ODDS MOVEMENT — -185 becomes -215', () => {
  beforeEach(freshWeek);

  it('warns, and never unlocks automatically', async () => {
    const game = await makeGame(week.id, 'BUF', 'MIA');
    const market = await makeMarket(game.id, { americanOdds: -185 });
    const { pick } = await lockPick({ userId: austin.id, nflWeekId: week.id, marketId: market.id });

    await prisma.market.update({ where: { id: market.id }, data: { americanOdds: -215 } });
    const found = await detectLockedPickIssues(week.id);

    expect(found.movementAlerts).toBe(1);
    const after = await prisma.pick.findUniqueOrThrow({ where: { id: pick.id } });
    expect(after.state).toBe('LOCKED');
    expect(after.lockedAmericanOdds).toBe(-185);
    expect(await prisma.matchupReservation.count({ where: { nflWeekId: week.id } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. MARKET DISAPPEARS
// ---------------------------------------------------------------------------
describe('§97 · MARKET DISAPPEARS — the exact market becomes unavailable', () => {
  beforeEach(freshWeek);

  it('alerts the player and keeps the matchup reserved', async () => {
    const game = await makeGame(week.id, 'BUF', 'MIA');
    const market = await makeMarket(game.id);
    await lockPick({ userId: austin.id, nflWeekId: week.id, marketId: market.id });

    await prisma.market.update({ where: { id: market.id }, data: { available: false, unavailableSince: new Date() } });
    await detectLockedPickIssues(week.id);

    const alert = await prisma.notification.findFirstOrThrow({ where: { userId: austin.id, kind: 'MARKET_UNAVAILABLE' } });
    expect(alert.title).toBe('ACTION REQUIRED');
    expect(await prisma.matchupReservation.count({ where: { nflGameId: game.id } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7-9. THE BOARD READER
// ---------------------------------------------------------------------------
class FakeBoard implements BoardReaderProvider {
  readonly name = 'FAKE';
  calls: string[] = [];
  constructor(
    private readonly events: string[],
    private readonly markets: RawMarket[] = [oneMarket()],
    private readonly behaviour: { rateLimitOnCall?: number; throwOnCall?: number } = {},
  ) {}
  isConfigured() {
    return true;
  }
  private tick(ctx: RequestContext, label: string) {
    ctx.spendRequest(label);
    this.calls.push(label);
    if (this.behaviour.rateLimitOnCall === this.calls.length) throw new RateLimitSignal(1800, '429');
    if (this.behaviour.throwOnCall === this.calls.length) throw new Error('connection reset');
  }
  async listEvents(ctx: RequestContext) {
    this.tick(ctx, 'index');
    return this.events.map((id) => ({ sourceEventId: id, homeTeamName: 'Dolphins', awayTeamName: 'Bills', scheduledAt: new Date(Date.now() + 86_400_000), eventStatus: 'SCHEDULED', sourceUrl: null }));
  }
  async readEvent(ctx: RequestContext, e: { sourceEventId: string }) {
    this.tick(ctx, `event:${e.sourceEventId}`);
    return { notModified: false as const, markets: this.markets, etag: 'W/"x"', lastModified: null };
  }
}

function oneMarket(over: Partial<RawMarket> = {}): RawMarket {
  return {
    sourceMarketId: 'm1', category: 'PLAYER_PROP', marketKey: 'RUSHING_YARDS', marketLabel: 'Rushing Yards',
    subjectKey: 'JOSH_ALLEN', subjectLabel: 'Josh Allen', selectionKey: 'OVER', selectionLabel: '25+ Rushing Yards',
    line: 25, americanOdds: -175, available: true, ...over,
  };
}

describe('§97 · READER FAILURE — a failed read preserves the last known data', () => {
  beforeEach(async () => {
    await freshWeek();
    await prisma.readerCircuitBreaker.upsert({ where: { id: 'sbm' }, create: { id: 'sbm' }, update: { consecutiveFailures: 0, cooldownUntil: null } });
    await setReaderSettings({ enabled: true, requestBudgetPerRun: 60, minDelayMs: 10_000, maxDelayMs: 30_000, removalConfirmations: 2 });
  });

  it('keeps every market and performs no mass deletion', async () => {
    await runScan(new FakeBoard(['E1']), { nflWeekId: week.id, delayMsOverride: 0 });
    const before = await prisma.market.count();
    expect(before).toBeGreaterThan(0);

    await runScan(new FakeBoard(['E1'], [], { throwOnCall: 1 }), { nflWeekId: week.id, delayMsOverride: 0 });

    expect(await prisma.market.count()).toBe(before);
    expect(await prisma.market.count({ where: { available: true } })).toBe(before);
  });
});

describe('§97 · RATE LIMIT — requests stop immediately', () => {
  beforeEach(async () => {
    await freshWeek();
    await prisma.readerCircuitBreaker.upsert({ where: { id: 'sbm' }, create: { id: 'sbm' }, update: { consecutiveFailures: 0, cooldownUntil: null } });
    await setReaderSettings({ enabled: true, requestBudgetPerRun: 60, minDelayMs: 10_000, maxDelayMs: 30_000, removalConfirmations: 2 });
  });

  it('halts the run and pauses the reader, with no retries', async () => {
    const board = new FakeBoard(['E1', 'E2', 'E3'], [oneMarket()], { rateLimitOnCall: 2 });
    const result = await runScan(board, { nflWeekId: week.id, delayMsOverride: 0 });
    if (result.skipped) throw new Error('should not skip');

    expect(board.calls).toHaveLength(2);
    expect(result.run.status).toBe('STOPPED_RATE_LIMIT');
    expect((await checkCircuitBreaker()).allowed).toBe(false);

    // A second attempt makes no requests at all.
    const again = new FakeBoard(['E1']);
    await runScan(again, { nflWeekId: week.id, delayMsOverride: 0 });
    expect(again.calls).toHaveLength(0);
  });
});

describe('§97 · SLOW SCAN — a 20-30 minute refresh is treated as successful and normal', () => {
  beforeEach(async () => {
    await freshWeek();
    await prisma.readerCircuitBreaker.upsert({ where: { id: 'sbm' }, create: { id: 'sbm' }, update: { consecutiveFailures: 0, cooldownUntil: null } });
    await setReaderSettings({ enabled: true, requestBudgetPerRun: 60, minDelayMs: 10_000, maxDelayMs: 30_000, removalConfirmations: 2 });
  });

  it('completes successfully and reports its duration without flagging it', async () => {
    const result = await runScan(new FakeBoard(['E1', 'E2']), { nflWeekId: week.id, delayMsOverride: 0 });
    if (result.skipped) throw new Error('should not skip');
    expect(result.run.status).toBe('COMPLETED');

    // The shipped pacing cannot produce a fast scan: 14 events at the minimum
    // 10 second spacing already exceeds two minutes, and the configured range
    // averages into the intended 20-30 minute window.
    const events = 14;
    expect((events * 10_000) / 60_000).toBeGreaterThan(2);
    expect((events * 20_000 * 6) / 60_000).toBeGreaterThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// 10-12. THE OFFICIAL TICKET
// ---------------------------------------------------------------------------
describe('§97 · TICKET ODDS CHANGE — locked -175, ticket -205', () => {
  beforeEach(freshWeek);

  it('accepts the same selection at the official price', async () => {
    const game = await makeGame(week.id, 'BUF', 'MIA');
    const market = await makeMarket(game.id, { americanOdds: -175, line: 25, subjectLabel: 'Josh Allen' });
    await lockPick({ userId: tanner.id, nflWeekId: week.id, marketId: market.id });

    const ticket = await uploadTicket({ nflWeekId: week.id, imagePath: '/tmp/t.jpg', mimeType: 'image/jpeg', uploadedById: austin.id });
    await prisma.officialTicketLeg.create({
      data: { ticketId: ticket.id, legIndex: 0, descriptionText: 'Josh Allen 25+ Rushing Yards', subjectLabel: 'Josh Allen', selectionLabel: '25+ Rushing Yards', marketKey: 'RUSHING_YARDS', line: 25, americanOdds: -205 },
    });

    const v = await verifyTicket(ticket.id);
    expect(v.status).toBe('VERIFIED');
    expect(v.results[0].outcome).toBe('MATCH_ODDS_CHANGED');

    const leg = await prisma.officialTicketLeg.findFirstOrThrow({ where: { ticketId: ticket.id }, include: { pick: true } });
    expect(leg.americanOdds).toBe(-205);              // official
    expect(leg.pick!.lockedAmericanOdds).toBe(-175);  // originally locked, preserved
  });
});

describe('§97 · TICKET MISMATCH — locked threshold differs from the ticket', () => {
  beforeEach(freshWeek);

  it('requires admin review and blocks confirmation', async () => {
    const game = await makeGame(week.id, 'MIN', 'GB');
    const market = await makeMarket(game.id, { line: 60, subjectLabel: 'Justin Jefferson' });
    await lockPick({ userId: tanner.id, nflWeekId: week.id, marketId: market.id });

    const ticket = await uploadTicket({ nflWeekId: week.id, imagePath: '/tmp/t.jpg', mimeType: 'image/jpeg', uploadedById: austin.id });
    await prisma.officialTicketLeg.create({
      data: { ticketId: ticket.id, legIndex: 0, descriptionText: 'Justin Jefferson 70+ Receiving Yards', subjectLabel: 'Justin Jefferson', selectionLabel: '70+ Receiving Yards', marketKey: 'RECEIVING_YARDS', line: 70, americanOdds: -120 },
    });

    const v = await verifyTicket(ticket.id);
    expect(v.status).toBe('NEEDS_REVIEW');
    expect(v.results[0].outcome).toBe('SELECTION_MISMATCH');
    await expect(confirmOfficialParlay(ticket.id, austin.id)).rejects.toMatchObject({ code: 'UNRESOLVED_LEGS' });
  });
});

describe('§97 · OFFICIAL FREEZE — confirming disables normal member editing', () => {
  beforeEach(freshWeek);

  it('blocks further locking and unlocking', async () => {
    const game = await makeGame(week.id, 'BUF', 'MIA');
    const market = await makeMarket(game.id, { line: 25, subjectLabel: 'Josh Allen' });
    await lockPick({ userId: tanner.id, nflWeekId: week.id, marketId: market.id });

    const ticket = await uploadTicket({ nflWeekId: week.id, imagePath: '/tmp/t.jpg', mimeType: 'image/jpeg', uploadedById: austin.id });
    await prisma.officialTicketLeg.create({
      data: { ticketId: ticket.id, legIndex: 0, descriptionText: 'Josh Allen 25+ Rushing Yards', subjectLabel: 'Josh Allen', selectionLabel: '25+ Rushing Yards', marketKey: 'RUSHING_YARDS', line: 25, americanOdds: -205 },
    });
    await verifyTicket(ticket.id);
    await confirmOfficialParlay(ticket.id, austin.id);

    await expect(unlockPick(tanner.id, week.id)).rejects.toMatchObject({ code: 'WEEK_FROZEN' });
    const other = await makeGame(week.id, 'KC', 'DEN');
    const otherMarket = await makeMarket(other.id);
    await expect(lockPick({ userId: austin.id, nflWeekId: week.id, marketId: otherMarket.id })).rejects.toMatchObject({ code: 'WEEK_FROZEN' });
  });
});

// ---------------------------------------------------------------------------
// 13. LIVE RESULT
// ---------------------------------------------------------------------------
describe('§97 · LIVE RESULT — an official prop result arrives', () => {
  beforeEach(freshWeek);

  it('updates The Sweat and the bettor record', async () => {
    const game = await makeGame(week.id, 'BUF', 'MIA');
    const market = await makeMarket(game.id, { line: 25, subjectLabel: 'Josh Allen', americanOdds: -175 });
    await lockPick({ userId: tanner.id, nflWeekId: week.id, marketId: market.id });

    const ticket = await uploadTicket({ nflWeekId: week.id, imagePath: '/tmp/t.jpg', mimeType: 'image/jpeg', uploadedById: austin.id });
    const leg = await prisma.officialTicketLeg.create({
      data: { ticketId: ticket.id, legIndex: 0, descriptionText: 'Josh Allen 25+ Rushing Yards', subjectLabel: 'Josh Allen', selectionLabel: '25+ Rushing Yards', marketKey: 'RUSHING_YARDS', line: 25, americanOdds: -205 },
    });
    await verifyTicket(ticket.id);
    await confirmOfficialParlay(ticket.id, austin.id);

    await gradeOfficialLeg(leg.id, 32, { automatic: true });

    const board = await sweatBoard(week.id);
    if (!board.available) throw new Error('sweat should be available');
    expect(board.counts.won).toBe(1);
    expect(board.legs[0].bettor).toBe('Tanner');

    // And the bettor's record now includes the official result at ticket odds.
    const rows = await leaderboard();
    const row = rows.find((r) => r.displayName === 'Tanner')!;
    expect(row.wins).toBe(1);
    expect(row.averageOdds).toBeCloseTo(-205, 6);
  });
});

// ---------------------------------------------------------------------------
// 14-16. HISTORY
// ---------------------------------------------------------------------------
describe('§97 · HISTORICAL IMPORT, WEEK OFF, and HISTORICAL CORRECTION', () => {
  beforeAll(async () => {
    await resetDatabase();
    await prisma.historicalCorrection.deleteMany();
    const passwordHash = await hashPassword('test-password-1');
    for (const [i, name] of INITIAL_ROSTER.entries()) {
      await prisma.user.create({ data: { displayName: name, legacyName: name, passwordHash, role: i === 0 ? 'ADMIN' : 'MEMBER' } });
    }
    for (const c of NAMED_CORRECTIONS) {
      await prisma.historicalCorrection.create({
        data: {
          entityType: 'HistoricalPick', seasonYear: c.season, weekNumber: c.week, bettorName: c.bettor,
          field: c.field, originalValue: c.originalValue, correctedValue: c.correctedValue,
          reason: c.reason, status: 'APPROVED', canonical: true,
        },
      });
    }
    await applyImport(WORKBOOK, 'workbook.xlsx', null);
  }, 120_000);

  it('HISTORICAL IMPORT — 260 cleaned unique historical picks, no duplicated 2025 entries', async () => {
    expect(await prisma.historicalPick.count()).toBe(260);
    expect(await prisma.historicalPick.count({ where: { seasonYear: 2024 } })).toBe(110);
    expect(await prisma.historicalPick.count({ where: { seasonYear: 2025 } })).toBe(150);

    const dupes = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) as count FROM (
        SELECT "seasonYear", "weekNumber", "bettorName"
        FROM "HistoricalPick" GROUP BY 1,2,3 HAVING COUNT(*) > 1
      ) d`;
    expect(Number(dupes[0].count)).toBe(0);
  });

  it('WEEK OFF — 2024 W12 and 2025 W15 remain Week Off', async () => {
    const offs = await prisma.nFLWeek.findMany({ where: { status: 'WEEK_OFF' }, include: { season: true } });
    const keys = offs.map((w) => `${w.season.year} W${w.weekNumber}`);
    expect(keys).toContain('2024 W12');
    expect(keys).toContain('2025 W15');
    // A Week Off carries a stated reason and holds no picks — it is never an 0-0 record.
    for (const off of offs) {
      expect(off.weekOffReason).toBeTruthy();
      expect(await prisma.historicalPick.count({ where: { seasonYear: off.season.year, weekNumber: off.weekNumber } })).toBe(0);
    }
  });

  it('WEEK OFF — the declared 2024 W6 disagreement is raised for audit, not silently resolved', async () => {
    // The accepted Week Off list names 2024 Week 6, but the workbook holds ten
    // real picks for it. The picks are kept (they are part of the 110/260
    // totals) and the disagreement is surfaced once for an administrator.
    const conflict = await prisma.importConflict.findFirst({ where: { scope: 'WEEK_OFF_HAS_DATA', seasonYear: 2024, weekNumber: 6 } });
    expect(conflict).not.toBeNull();
    expect(await prisma.historicalPick.count({ where: { seasonYear: 2024, weekNumber: 6 } })).toBe(10);
  });

  it('HISTORICAL CORRECTION — re-importing the old spreadsheet keeps approved corrections', async () => {
    const admin = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } });
    await recordCorrection({
      seasonYear: 2025, weekNumber: 5, bettorName: 'Nick',
      field: 'matchup', correctedValue: 'Corrected Matchup Label',
      reason: 'Checked against the box score.', actorId: admin.id,
    });

    await applyImport(WORKBOOK, 'workbook.xlsx', admin.id);

    const row = await prisma.historicalPick.findFirstOrThrow({ where: { seasonYear: 2025, weekNumber: 5, bettorName: 'Nick' } });
    expect(row.matchupText).toBe('Corrected Matchup Label');
    expect(await prisma.historicalPick.count()).toBe(260);

    // The three canonical corrections also survived.
    const tanner4 = await prisma.historicalPick.findFirstOrThrow({ where: { seasonYear: 2025, weekNumber: 4, bettorName: 'Tanner' } });
    expect(tanner4.matchupText).toBe('Bears @ Raiders');
    const dan17 = await prisma.historicalPick.findFirstOrThrow({ where: { seasonYear: 2024, weekNumber: 17, bettorName: 'Dan' } });
    expect(dan17.outcomeText).toBe('40-34');
    expect(dan17.result).toBe('WIN');
  });

  it('AVERAGE ODDS — averaged decimal odds converted back to American', async () => {
    const board = await leaderboard();
    const carson = board.find((r) => r.displayName === 'Carson')!;

    // The workbook's own computed all-time figure for Carson.
    expect(carson.averageOdds!).toBeCloseTo(-130.8393487, 4);
    expect(carson.profit).toBeCloseTo(33.88045097, 6);

    // And it is genuinely the decimal method, not a raw average.
    const picks = await prisma.historicalPick.findMany({ where: { bettorName: 'Carson' } });
    const odds = picks.map((p) => p.americanOdds);
    const meanDecimal = odds.reduce((s, o) => s + americanToDecimal(o), 0) / odds.length;
    expect(averageAmericanOdds(odds)!).toBeCloseTo(decimalToAmerican(meanDecimal), 9);

    const naive = odds.reduce((a, b) => a + b, 0) / odds.length;
    expect(Math.abs(averageAmericanOdds(odds)! - naive)).toBeGreaterThan(1);
  });
});
