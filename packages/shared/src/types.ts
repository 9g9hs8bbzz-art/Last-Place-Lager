/** Shared vocabulary used by the API, the web client and any future native client. */

/** Pick lifecycle (spec §52). */
export type PickLifecycle =
  | 'WATCHED'
  | 'PENDING'
  | 'LOCKED'
  | 'PARLAY_READY'
  | 'TICKET_UPLOADED'
  | 'OFFICIAL'
  | 'LIVE'
  | 'SETTLED';

/** How a matchup appears to a given member (spec §9). */
export type MatchupState =
  | 'AVAILABLE'
  | 'MY_PENDING_GAME'
  | 'MY_RESERVED_GAME'
  | 'RESERVED_BY_OTHER'
  | 'NOT_ELIGIBLE'
  | 'STARTED'
  | 'CLOSED';

/** Week-level status shown on the admin readiness dashboard (spec §53). */
export type WeekStatus =
  | 'IN_PROGRESS'
  | 'ALL_LOCKED'
  | 'ACTION_REQUIRED'
  | 'READY_TO_PLACE'
  | 'TICKET_UPLOADED'
  | 'OFFICIAL'
  | 'LIVE'
  | 'SETTLED'
  | 'WEEK_OFF';

/** Sportsbook reader health (spec §26). */
export type ReaderHealth = 'HEALTHY' | 'STALE' | 'PARTIAL' | 'ERROR' | 'PAUSED_FOR_SAFETY';

export type Role = 'MEMBER' | 'ADMIN';

/** Why a member is being notified (spec §89). */
export type NotificationKind =
  | 'PICK_NEEDED'
  | 'MATCHUP_TAKEN'
  | 'MARKET_UNAVAILABLE'
  | 'ODDS_MOVEMENT'
  | 'ODDS_GUIDELINE'
  | 'NEWS_INJURY'
  | 'ALL_LOCKED'
  | 'OFFICIAL'
  | 'RESULT'
  | 'THE_SWEAT';

/** Per-member readiness row on the admin dashboard (spec §53). */
export interface ReadinessRow {
  userId: string;
  displayName: string;
  matchupReserved: boolean;
  exactMarketAvailable: boolean | null;
  withinOddsGuideline: boolean | null;
  lockedOdds: number | null;
  currentOdds: number | null;
  actionRequired: boolean;
  notes: string[];
}

/**
 * Returned wherever a provider has no data. The app shows this instead of
 * inventing values (spec §95).
 */
export interface DataUnavailable {
  status: 'DATA_UNAVAILABLE';
  provider: string;
  reason: string;
  lastSuccessfulAt: string | null;
}

export function dataUnavailable(provider: string, reason: string, lastSuccessfulAt: string | null = null): DataUnavailable {
  return { status: 'DATA_UNAVAILABLE', provider, reason, lastSuccessfulAt };
}

export function isDataUnavailable(value: unknown): value is DataUnavailable {
  return typeof value === 'object' && value !== null && (value as DataUnavailable).status === 'DATA_UNAVAILABLE';
}

/** Freshness phrasing for sportsbook data (spec §34). Never implies real-time. */
export function freshnessLabel(lastVerifiedAt: Date | null, now: Date = new Date()): string {
  if (!lastVerifiedAt) return 'Sports Bet Montana — never successfully updated';
  const minutes = Math.floor((now.getTime() - lastVerifiedAt.getTime()) / 60000);
  if (minutes < 1) return 'Sports Bet Montana — verified moments ago';
  if (minutes < 60) return `Sports Bet Montana — verified ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  const stale = hours >= 2 ? '⚠ Data may be stale — last successful update' : 'Sports Bet Montana — verified';
  return `${stale} ${hours} hour${hours === 1 ? '' : 's'} ago`;
}
