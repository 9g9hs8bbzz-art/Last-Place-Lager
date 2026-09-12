/**
 * NFL schedule, live scores and player statistics from ESPN's public endpoints.
 *
 * These endpoints are free and require no key, which is why the group chose
 * them — but they are UNDOCUMENTED and unofficial. ESPN can change or withdraw
 * them without notice. Two things follow, and both are deliberate:
 *
 *   1. Every parser here is defensive. Anything it cannot read confidently
 *      becomes DATA_UNAVAILABLE, never a guess, so a shape change degrades the
 *      app into honest emptiness rather than wrong numbers (spec §95).
 *   2. This file sits behind ScheduleProvider and LiveScoreProvider like every
 *      other integration, so replacing ESPN with a paid feed later is a change
 *      to the registry and this one file (spec §87).
 *
 * Requests are modest and cached: the schedule changes rarely, and live polling
 * is driven by the scheduler, not by page views.
 */
import { dataUnavailable, normalizeKey } from '@fcp/shared';
import type {
  LiveGameState,
  LivePlayerStat,
  LiveScoreProvider,
  ProviderResult,
  ScheduleGame,
  ScheduleProvider,
} from './types.js';

/**
 * Overridable so the endpoint can be pointed at a mirror, or at a local
 * stand-in during testing, without touching the code.
 */
const BASE = (process.env.ESPN_BASE_URL?.trim() || 'https://site.api.espn.com/apis/site/v2/sports/football/nfl').replace(/\/$/, '');
const PROVIDER = 'ESPN';

/** Identify honestly, and give a contact so ESPN can reach us if we cause trouble. */
const USER_AGENT =
  process.env.ESPN_USER_AGENT?.trim() ||
  'FirstClassParlays/1.0 (private group tool; https://github.com/9g9hs8bbzz-art/Last-Place-Lager)';

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * ESPN's abbreviations against ours. Only the ones that genuinely differ are
 * listed; everything else matches, and Team.aliases covers the rest.
 */
const ABBREV_FIXUPS: Record<string, string> = {
  WSH: 'WAS',
  JAC: 'JAX',
  LA: 'LAR',
  OAK: 'LV',
  SD: 'LAC',
  STL: 'LAR',
};

export function normalizeAbbrev(raw: string): string {
  const up = raw.trim().toUpperCase();
  return ABBREV_FIXUPS[up] ?? up;
}

async function getJson(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    // Network failure, timeout or malformed JSON all mean "no data", never
    // "the games have disappeared".
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- schedule

/** Map ESPN's status vocabulary onto ours. Unknown states stay SCHEDULED. */
export function mapGameStatus(state: string | undefined, name: string | undefined): LiveGameState['status'] {
  const n = (name ?? '').toUpperCase();
  if (n.includes('POSTPONED')) return 'POSTPONED';
  if (n.includes('CANCELED') || n.includes('CANCELLED')) return 'CANCELED';
  if (n.includes('FINAL')) return 'FINAL';

  switch ((state ?? '').toLowerCase()) {
    case 'in':
      return 'IN_PROGRESS';
    case 'post':
      return 'FINAL';
    case 'pre':
    default:
      return 'SCHEDULED';
  }
}

/**
 * Read one scoreboard payload into schedule rows.
 * Exported so it can be tested against recorded payloads without a network.
 */
export function parseScoreboard(payload: unknown): ScheduleGame[] {
  const root = payload as { events?: unknown[] } | null;
  if (!root || !Array.isArray(root.events)) return [];

  const games: ScheduleGame[] = [];
  for (const raw of root.events) {
    // ESPN occasionally includes nulls, and a shape change could put anything
    // here. A single bad entry must not take the whole slate down.
    if (typeof raw !== 'object' || raw === null) continue;
    const event = raw as {
      id?: unknown;
      date?: unknown;
      competitions?: {
        venue?: { fullName?: unknown; indoor?: unknown };
        competitors?: { homeAway?: unknown; team?: { abbreviation?: unknown } }[];
      }[];
    };

    const providerGameId = event.id === undefined ? '' : String(event.id).trim();
    const competition = Array.isArray(event.competitions) ? event.competitions[0] : undefined;
    const competitors = competition?.competitors;
    if (!providerGameId || !Array.isArray(competitors)) continue;

    const home = competitors.find((c) => String(c?.homeAway).toLowerCase() === 'home');
    const away = competitors.find((c) => String(c?.homeAway).toLowerCase() === 'away');
    const homeAbbrev = home?.team?.abbreviation ? normalizeAbbrev(String(home.team.abbreviation)) : '';
    const awayAbbrev = away?.team?.abbreviation ? normalizeAbbrev(String(away.team.abbreviation)) : '';
    if (!homeAbbrev || !awayAbbrev) continue;

    const kickoffAt = event.date ? new Date(String(event.date)) : null;
    if (!kickoffAt || Number.isNaN(kickoffAt.getTime())) continue;

    games.push({
      providerGameId,
      awayTeamAbbrev: awayAbbrev,
      homeTeamAbbrev: homeAbbrev,
      kickoffAt,
      venue: competition?.venue?.fullName ? String(competition.venue.fullName) : null,
      indoor: competition?.venue?.indoor === true,
    });
  }
  return games;
}

/** Read live state out of the same scoreboard payload. */
export function parseLiveStates(payload: unknown): LiveGameState[] {
  const root = payload as { events?: unknown[] } | null;
  if (!root || !Array.isArray(root.events)) return [];

  const states: LiveGameState[] = [];
  for (const raw of root.events) {
    if (typeof raw !== 'object' || raw === null) continue;
    const event = raw as {
      id?: unknown;
      competitions?: {
        competitors?: { homeAway?: unknown; score?: unknown }[];
        status?: {
          period?: unknown;
          displayClock?: unknown;
          type?: { state?: unknown; name?: unknown };
        };
      }[];
    };

    const providerGameId = event.id === undefined ? '' : String(event.id).trim();
    const competition = Array.isArray(event.competitions) ? event.competitions[0] : undefined;
    if (!providerGameId || !competition) continue;

    const competitors = competition.competitors ?? [];
    const home = competitors.find((c) => String(c?.homeAway).toLowerCase() === 'home');
    const away = competitors.find((c) => String(c?.homeAway).toLowerCase() === 'away');

    const status = competition.status;
    const period = Number(status?.period);

    states.push({
      providerGameId,
      status: mapGameStatus(
        status?.type?.state === undefined ? undefined : String(status.type.state),
        status?.type?.name === undefined ? undefined : String(status.type.name),
      ),
      homeScore: intOrNull(home?.score),
      awayScore: intOrNull(away?.score),
      quarter: Number.isFinite(period) && period > 0 ? quarterLabel(period) : null,
      clock: status?.displayClock ? String(status.displayClock) : null,
    });
  }
  return states;
}

function quarterLabel(period: number): string {
  if (period <= 4) return `Q${period}`;
  return period === 5 ? 'OT' : `OT${period - 4}`;
}

function intOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ------------------------------------------------------------ player stats

/**
 * ESPN groups box-score statistics by category, each with a `keys` array
 * naming the columns and one `stats` array per player. This maps the columns
 * we can grade against onto the app's own statistic vocabulary.
 */
const STAT_KEY_MAP: Record<string, string> = {
  passingYards: 'PASSING_YARDS',
  passingTouchdowns: 'PASSING_TOUCHDOWNS',
  interceptions: 'INTERCEPTIONS',
  rushingYards: 'RUSHING_YARDS',
  rushingTouchdowns: 'RUSHING_TOUCHDOWNS',
  rushingAttempts: 'CARRIES',
  receivingYards: 'RECEIVING_YARDS',
  receivingTouchdowns: 'RECEIVING_TOUCHDOWNS',
  receptions: 'RECEPTIONS',
  receivingTargets: 'TARGETS',
  longRushing: 'LONG_RUSH',
  longReception: 'LONG_RECEPTION',
  totalKickingPoints: 'KICKING_POINTS',
};

/**
 * "Completions/attempts" style columns arrive as a single "21/33" string, so
 * the two halves are split out into their own statistics.
 */
const SPLIT_KEYS: Record<string, [string, string]> = {
  'completions/passingAttempts': ['COMPLETIONS', 'PASS_ATTEMPTS'],
  'fieldGoalsMade/fieldGoalAttempts': ['FIELD_GOALS_MADE', 'FIELD_GOAL_ATTEMPTS'],
  'extraPointsMade/extraPointAttempts': ['EXTRA_POINTS_MADE', 'EXTRA_POINT_ATTEMPTS'],
};

/** Read a summary payload into per-player statistics. Exported for testing. */
export function parseBoxScore(payload: unknown): LivePlayerStat[] {
  const root = payload as { boxscore?: { players?: unknown[] } } | null;
  const teams = root?.boxscore?.players;
  if (!Array.isArray(teams)) return [];

  const out: LivePlayerStat[] = [];
  const seen = new Set<string>();

  for (const teamBlock of teams) {
    if (typeof teamBlock !== 'object' || teamBlock === null) continue;
    const groups = (teamBlock as { statistics?: unknown[] }).statistics;
    if (!Array.isArray(groups)) continue;

    for (const groupRaw of groups) {
      if (typeof groupRaw !== 'object' || groupRaw === null) continue;
      const group = groupRaw as { keys?: unknown[]; athletes?: unknown[] };
      const keys = Array.isArray(group.keys) ? group.keys.map((k) => String(k)) : [];
      const athletes = Array.isArray(group.athletes) ? group.athletes : [];

      for (const athleteRaw of athletes) {
        if (typeof athleteRaw !== 'object' || athleteRaw === null) continue;
        const entry = athleteRaw as { athlete?: { displayName?: unknown }; stats?: unknown[] };
        const playerName = entry.athlete?.displayName ? String(entry.athlete.displayName) : '';
        const stats = Array.isArray(entry.stats) ? entry.stats : [];
        if (!playerName) continue;

        const subjectKey = normalizeKey(playerName);

        keys.forEach((key, index) => {
          const rawValue = stats[index];
          if (rawValue === undefined) return;

          const split = SPLIT_KEYS[key];
          if (split) {
            const [madeRaw, attemptedRaw] = String(rawValue).split('/');
            pushStat(out, seen, subjectKey, playerName, split[0], numOrNull(madeRaw));
            pushStat(out, seen, subjectKey, playerName, split[1], numOrNull(attemptedRaw));
            return;
          }

          const statKey = STAT_KEY_MAP[key];
          if (!statKey) return;
          pushStat(out, seen, subjectKey, playerName, statKey, numOrNull(rawValue));
        });
      }
    }
  }

  // Rushing + receiving is a real market, so derive it where both halves exist.
  const combined = new Map<string, { name: string; rush: number | null; rec: number | null }>();
  for (const s of out) {
    if (s.statKey !== 'RUSHING_YARDS' && s.statKey !== 'RECEIVING_YARDS') continue;
    const row = combined.get(s.subjectKey) ?? { name: s.playerName, rush: null, rec: null };
    if (s.statKey === 'RUSHING_YARDS') row.rush = s.value;
    else row.rec = s.value;
    combined.set(s.subjectKey, row);
  }
  for (const [subjectKey, row] of combined) {
    if (row.rush === null && row.rec === null) continue;
    pushStat(out, seen, subjectKey, row.name, 'RUSHING_AND_RECEIVING_YARDS', (row.rush ?? 0) + (row.rec ?? 0));
  }

  return out;
}

function pushStat(
  out: LivePlayerStat[],
  seen: Set<string>,
  subjectKey: string,
  playerName: string,
  statKey: string,
  value: number | null,
) {
  if (value === null) return;
  const dedupe = `${subjectKey}:${statKey}`;
  if (seen.has(dedupe)) return;
  seen.add(dedupe);
  out.push({ subjectKey, playerName, statKey, value });
}

// ------------------------------------------------------------- the provider

export class EspnProvider implements ScheduleProvider, LiveScoreProvider {
  readonly name = PROVIDER;

  /** No key is needed, so this is available unless explicitly switched off. */
  isConfigured(): boolean {
    return (process.env.NFL_DATA_SOURCE ?? 'espn').trim().toLowerCase() === 'espn';
  }

  async getWeekSchedule(season: number, week: number): Promise<ProviderResult<ScheduleGame[]>> {
    if (!this.isConfigured()) return dataUnavailable(PROVIDER, 'The ESPN data source is switched off.');

    // seasontype 2 is the regular season; 3 is the post-season.
    const seasonType = week > 18 ? 3 : 2;
    const url = `${BASE}/scoreboard?dates=${season}&seasontype=${seasonType}&week=${week}`;
    const payload = await getJson(url);
    if (payload === null) {
      return dataUnavailable(PROVIDER, `Could not reach ESPN for ${season} week ${week}.`);
    }

    const games = parseScoreboard(payload);
    if (games.length === 0) {
      // An empty slate is far more likely to mean the shape changed than that
      // the NFL scheduled no games, so it is reported as unavailable.
      return dataUnavailable(PROVIDER, `ESPN returned no readable games for ${season} week ${week}.`);
    }
    return { status: 'OK', data: games, fetchedAt: new Date(), provider: PROVIDER };
  }

  async getGameStates(providerGameIds: string[]): Promise<ProviderResult<LiveGameState[]>> {
    if (!this.isConfigured()) return dataUnavailable(PROVIDER, 'The ESPN data source is switched off.');
    if (providerGameIds.length === 0) {
      return { status: 'OK', data: [], fetchedAt: new Date(), provider: PROVIDER };
    }

    // One scoreboard request covers the whole slate, so live polling costs a
    // single request no matter how many games are being followed.
    const payload = await getJson(`${BASE}/scoreboard`);
    if (payload === null) return dataUnavailable(PROVIDER, 'Could not reach ESPN for live scores.');

    const wanted = new Set(providerGameIds);
    const states = parseLiveStates(payload).filter((s) => wanted.has(s.providerGameId));
    return { status: 'OK', data: states, fetchedAt: new Date(), provider: PROVIDER };
  }

  async getPlayerStats(providerGameId: string): Promise<ProviderResult<LivePlayerStat[]>> {
    if (!this.isConfigured()) return dataUnavailable(PROVIDER, 'The ESPN data source is switched off.');

    const payload = await getJson(`${BASE}/summary?event=${encodeURIComponent(providerGameId)}`);
    if (payload === null) {
      return dataUnavailable(PROVIDER, `Could not reach ESPN for game ${providerGameId}.`);
    }

    const stats = parseBoxScore(payload);
    if (stats.length === 0) {
      // Before kickoff there is genuinely no box score; that is not an error,
      // but there is nothing to grade from either.
      return dataUnavailable(PROVIDER, `No box score is available yet for game ${providerGameId}.`);
    }
    return { status: 'OK', data: stats, fetchedAt: new Date(), provider: PROVIDER };
  }
}

export const espnProvider = new EspnProvider();
