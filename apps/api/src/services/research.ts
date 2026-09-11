/**
 * Wager research (spec §37-§51).
 *
 * The research panel is assembled per wager: what is gathered depends on what
 * is actually being bet. Every figure carries its source, its sample size and
 * when it was collected (spec §47). Nothing is filled in with plausible-looking
 * numbers — a missing provider produces an explicit gap (spec §95).
 */
import { prisma } from '../lib/prisma.js';
import { isDataUnavailable, normalizeKey, americanToDecimal } from '@fcp/shared';
import {
  statsProvider, injuryProvider, weatherProvider, newsProvider, aiResearchProvider,
} from '../providers/registry.js';

export interface ResearchSection<T> {
  available: boolean;
  provider: string;
  fetchedAt: string | null;
  /** Shown to the member when `available` is false. */
  unavailableReason: string | null;
  data: T | null;
}

function gap<T>(provider: string, reason: string): ResearchSection<T> {
  return { available: false, provider, fetchedAt: null, unavailableReason: reason, data: null };
}

const UNAVAILABLE_TEXT = 'DATA CURRENTLY UNAVAILABLE';

/**
 * Decide which statistic a wager is really about, so research is specific to
 * the bet rather than generic team pages (spec §39, §43).
 */
export function researchPlanFor(market: { marketKey: string; category: string; subjectLabel: string | null; line: unknown }) {
  const key = market.marketKey.toUpperCase();
  const isPlayer = Boolean(market.subjectLabel) && market.category === 'PLAYER_PROP';

  let statKey = key;
  let defensiveStatKey: string | null = null;
  let usageKeys: string[] = [];

  if (key.includes('RUSH')) {
    statKey = 'RUSHING_YARDS';
    defensiveStatKey = 'RUSHING_YARDS_ALLOWED';
    usageKeys = ['CARRIES', 'RUSH_SHARE', 'RED_ZONE_CARRIES', 'GOAL_LINE_CARRIES'];
  } else if (key.includes('RECEIV') || key.includes('RECEPTION')) {
    statKey = key.includes('RECEPTION') ? 'RECEPTIONS' : 'RECEIVING_YARDS';
    defensiveStatKey = 'RECEIVING_YARDS_ALLOWED_TO_POSITION';
    usageKeys = ['TARGETS', 'TARGET_SHARE', 'ROUTES_RUN', 'AIR_YARDS', 'RED_ZONE_TARGETS'];
  } else if (key.includes('PASS')) {
    statKey = key.includes('TD') ? 'PASSING_TOUCHDOWNS' : 'PASSING_YARDS';
    defensiveStatKey = 'PASSING_YARDS_ALLOWED';
    usageKeys = ['ATTEMPTS', 'COMPLETIONS', 'PRESSURE_RATE_FACED'];
  } else if (key.includes('TOUCHDOWN') || key.includes('ATD')) {
    statKey = 'TOUCHDOWNS';
    defensiveStatKey = 'TOUCHDOWNS_ALLOWED';
    usageKeys = ['RED_ZONE_TOUCHES', 'GOAL_LINE_CARRIES'];
  } else if (key.includes('SPREAD') || key.includes('MONEYLINE')) {
    statKey = 'TEAM_RESULTS';
    defensiveStatKey = 'POINTS_ALLOWED';
  } else if (key.includes('TOTAL')) {
    statKey = 'TEAM_POINTS';
    defensiveStatKey = 'POINTS_ALLOWED';
  }

  return { statKey, defensiveStatKey, usageKeys, isPlayer };
}

/** Build the whole research panel for one sportsbook selection. */
export async function researchForMarket(marketId: string) {
  const market = await prisma.market.findUnique({
    where: { id: marketId },
    include: {
      event: { include: { nflGame: { include: { homeTeam: true, awayTeam: true, weather: true } } } },
      snapshots: { orderBy: { observedAt: 'desc' }, take: 25 },
    },
  });
  if (!market) return null;

  const game = market.event.nflGame;
  const subjectKey = market.subjectKey ?? (market.subjectLabel ? normalizeKey(market.subjectLabel) : null);
  const plan = researchPlanFor({ marketKey: market.marketKey, category: market.category, subjectLabel: market.subjectLabel, line: market.line });

  const wagerDescription = [market.subjectLabel, market.selectionLabel].filter(Boolean).join(' ');
  const opponentAbbrev = game ? game.homeTeam.abbreviation : null;

  const [hitRates, alternates, defense, injuries, weather, news] = await Promise.all([
    buildHitRates(subjectKey, plan.statKey, opponentAbbrev),
    buildAlternateThresholds(market),
    buildDefensiveContext(game, plan.defensiveStatKey),
    buildInjuries(game),
    buildWeather(game),
    buildNews(wagerDescription, market.subjectLabel, game),
  ]);

  const summary = await buildAiSummary(marketId, wagerDescription, { hitRates, defense, injuries, weather, news });

  return {
    wager: {
      marketId: market.id,
      description: wagerDescription,
      marketLabel: market.marketLabel,
      selectionLabel: market.selectionLabel,
      line: market.line === null ? null : Number(market.line),
      americanOdds: market.americanOdds,
      available: market.available,
      source: market.source,
      lastVerifiedAt: market.lastVerifiedAt,
      matchup: game ? `${game.awayTeam.nickname} @ ${game.homeTeam.nickname}` : null,
      kickoffAt: game?.kickoffAt ?? null,
      indoor: game?.indoor ?? null,
    },
    // Line movement is our own record, so it is always available (spec §50).
    lineMovement: {
      available: true,
      provider: 'FIRST_CLASS_PARLAYS',
      fetchedAt: new Date().toISOString(),
      unavailableReason: null,
      data: market.snapshots.map((s) => ({
        observedAt: s.observedAt,
        americanOdds: s.americanOdds,
        line: s.line === null ? null : Number(s.line),
        available: s.available,
        source: s.source,
      })),
    },
    hitRates,
    alternates,
    defense,
    injuries,
    weather,
    news,
    summary,
  };
}

/** Hit-rate panel with sample sizes always shown (spec §40, §41). */
async function buildHitRates(subjectKey: string | null, statKey: string, opponentAbbrev: string | null) {
  if (!subjectKey) return gap<never>('NFL_STATS', 'This wager is not about a single player.');
  if (!statsProvider.isConfigured()) return gap<never>('NFL_STATS', UNAVAILABLE_TEXT);

  const result = await statsProvider.getPlayerSamples(subjectKey, statKey, opponentAbbrev);
  if (isDataUnavailable(result)) return gap<never>('NFL_STATS', result.reason);

  return {
    available: true,
    provider: result.provider,
    fetchedAt: result.fetchedAt.toISOString(),
    unavailableReason: null,
    data: result.data.map((s) => ({
      sample: s.sampleKey,
      hits: s.hits,
      sampleSize: s.sampleSize,
      // A 2/3 sample is never presented as more than a 2/3 sample (spec §40).
      display: s.hits === null ? '—' : `${s.hits}/${s.sampleSize}`,
      value: s.value,
      gameLog: s.gameLog,
    })),
  };
}

/** Alternate thresholds on the same statistic, priced side by side (spec §42). */
async function buildAlternateThresholds(market: { id: string; eventId: string; marketKey: string; subjectKey: string | null }) {
  const siblings = await prisma.market.findMany({
    where: {
      eventId: market.eventId,
      marketKey: market.marketKey,
      subjectKey: market.subjectKey,
      line: { not: null },
    },
    orderBy: { line: 'asc' },
  });

  return {
    available: siblings.length > 0,
    provider: 'SPORTS_BET_MONTANA',
    fetchedAt: new Date().toISOString(),
    unavailableReason: siblings.length === 0 ? 'No alternate lines are listed for this market.' : null,
    data: siblings.map((s) => ({
      marketId: s.id,
      line: s.line === null ? null : Number(s.line),
      label: s.selectionLabel,
      americanOdds: s.americanOdds,
      available: s.available,
      isCurrent: s.id === market.id,
      // Hit rates for each alternate arrive with the stats provider.
      impliedProbability: s.americanOdds === null ? null : 1 / americanToDecimal(s.americanOdds),
    })),
  };
}

async function buildDefensiveContext(game: { homeTeam: { abbreviation: string }; awayTeam: { abbreviation: string } } | null, defensiveStatKey: string | null) {
  if (!game || !defensiveStatKey) return gap<never>('NFL_STATS', 'No opponent context applies to this wager.');
  if (!statsProvider.isConfigured()) return gap<never>('NFL_STATS', UNAVAILABLE_TEXT);

  const result = await statsProvider.getDefensiveRanks(game.homeTeam.abbreviation, defensiveStatKey);
  if (isDataUnavailable(result)) return gap<never>('NFL_STATS', result.reason);
  return { available: true, provider: result.provider, fetchedAt: result.fetchedAt.toISOString(), unavailableReason: null, data: result.data };
}

async function buildInjuries(game: { id: string; homeTeam: { abbreviation: string }; awayTeam: { abbreviation: string } } | null) {
  if (!game) return gap<never>('INJURIES', 'No game linked to this wager yet.');
  if (!injuryProvider.isConfigured()) {
    // Fall back to anything an administrator entered by hand.
    const stored = await prisma.injury.findMany({ where: { nflGameId: game.id }, orderBy: { reportedAt: 'desc' } });
    if (stored.length === 0) return gap<never>('INJURIES', UNAVAILABLE_TEXT);
    return { available: true, provider: 'ADMIN_MANUAL', fetchedAt: stored[0].fetchedAt.toISOString(), unavailableReason: null, data: stored };
  }
  const result = await injuryProvider.getInjuries([game.homeTeam.abbreviation, game.awayTeam.abbreviation]);
  if (isDataUnavailable(result)) return gap<never>('INJURIES', result.reason);
  return { available: true, provider: result.provider, fetchedAt: result.fetchedAt.toISOString(), unavailableReason: null, data: result.data };
}

async function buildWeather(game: { id: string; indoor: boolean; venue: string | null; kickoffAt: Date; weather: unknown } | null) {
  if (!game) return gap<never>('WEATHER', 'No game linked to this wager yet.');
  if (game.indoor) {
    return {
      available: true,
      provider: 'FIRST_CLASS_PARLAYS',
      fetchedAt: new Date().toISOString(),
      unavailableReason: null,
      data: { indoor: true, note: 'Indoor game — weather not expected to materially affect play.' },
    };
  }
  if (!weatherProvider.isConfigured()) {
    const stored = await prisma.weather.findUnique({ where: { nflGameId: game.id } });
    if (!stored) return gap<never>('WEATHER', UNAVAILABLE_TEXT);
    return { available: true, provider: stored.provider, fetchedAt: stored.fetchedAt.toISOString(), unavailableReason: null, data: stored };
  }
  const result = await weatherProvider.getForecast(game.venue ?? '', game.kickoffAt);
  if (isDataUnavailable(result)) return gap<never>('WEATHER', result.reason);
  return { available: true, provider: result.provider, fetchedAt: result.fetchedAt.toISOString(), unavailableReason: null, data: result.data };
}

async function buildNews(wagerDescription: string, subjectLabel: string | null, game: { homeTeam: { nickname: string }; awayTeam: { nickname: string } } | null) {
  if (!newsProvider.isConfigured()) return gap<never>('NEWS', UNAVAILABLE_TEXT);
  const query = [subjectLabel, game ? `${game.awayTeam.nickname} ${game.homeTeam.nickname}` : null, wagerDescription]
    .filter(Boolean)
    .join(' ');
  const result = await newsProvider.search(query, 8);
  if (isDataUnavailable(result)) return gap<never>('NEWS', result.reason);
  // Every item keeps its source, title, date and link (spec §45).
  return { available: true, provider: result.provider, fetchedAt: result.fetchedAt.toISOString(), unavailableReason: null, data: result.data };
}

/**
 * Case For / Case Against (spec §46).
 * Built only from evidence that was actually gathered, and never accompanied by
 * an invented confidence score.
 */
async function buildAiSummary(marketId: string, wagerDescription: string, sections: Record<string, { available: boolean; provider: string; data: unknown }>) {
  if (!aiResearchProvider.isConfigured()) return gap<never>('AI_RESEARCH', UNAVAILABLE_TEXT);

  const evidence = Object.entries(sections)
    .filter(([, s]) => s.available && s.data)
    .map(([kind, s]) => ({ kind, id: `${marketId}:${kind}`, text: JSON.stringify(s.data).slice(0, 4000), source: s.provider }));

  if (evidence.length === 0) {
    return gap<never>('AI_RESEARCH', 'No underlying evidence has been gathered yet, so no summary can be written.');
  }

  const result = await aiResearchProvider.summarize({ wagerDescription, evidence });
  if (isDataUnavailable(result)) return gap<never>('AI_RESEARCH', result.reason);

  await prisma.researchSummary.create({
    data: {
      marketId,
      provider: result.provider,
      caseFor: result.data.caseFor,
      caseAgainst: result.data.caseAgainst,
      bottomLine: result.data.bottomLine,
      sourceRefs: result.data.sourceRefs,
    },
  });

  return {
    available: true,
    provider: result.provider,
    fetchedAt: result.fetchedAt.toISOString(),
    unavailableReason: null,
    data: {
      caseFor: result.data.caseFor,
      caseAgainst: result.data.caseAgainst,
      bottomLine: result.data.bottomLine,
      sourceRefs: result.data.sourceRefs,
      // Deliberately no confidence percentage (spec §46).
      note: 'This summary organises the sourced evidence above. It is not a prediction.',
    },
  };
}

/** Historical performance of similar wagers by this group (always available). */
export async function groupHistoryForWager(subjectLabel: string | null, marketKey: string) {
  const term = subjectLabel?.split(' ').pop();
  const rows = await prisma.historicalPick.findMany({
    where: {
      result: { in: ['WIN', 'LOSS'] },
      ...(term ? { pickText: { contains: term, mode: 'insensitive' } } : {}),
    },
    orderBy: [{ seasonYear: 'desc' }, { weekNumber: 'desc' }],
    take: 25,
  });
  return {
    available: true,
    provider: 'FIRST_CLASS_PARLAYS',
    fetchedAt: new Date().toISOString(),
    unavailableReason: null,
    sampleSize: rows.length,
    data: rows,
  };
}
