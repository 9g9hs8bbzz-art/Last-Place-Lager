/**
 * Provider interfaces (spec §87).
 *
 * Every external dependency sits behind one of these so that a provider going
 * away, changing shape or being replaced by an official feed does not require
 * rewriting the application. Each provider reports its own availability; when
 * one is not configured, the app surfaces DATA CURRENTLY UNAVAILABLE rather
 * than inventing values (spec §95).
 */
import type { DataUnavailable } from '@fcp/shared';

export type ProviderResult<T> = { status: 'OK'; data: T; fetchedAt: Date; provider: string } | DataUnavailable;

export interface Provider {
  readonly name: string;
  /** False when the provider has no credentials or endpoint configured. */
  isConfigured(): boolean;
}

// ---------------------------------------------------------------- sportsbook

export interface RawSportsbookEvent {
  sourceEventId: string;
  homeTeamName: string;
  awayTeamName: string;
  scheduledAt: Date | null;
  eventStatus: string | null;
  sourceUrl: string | null;
}

export interface RawMarket {
  sourceMarketId: string | null;
  category: string;
  marketKey: string;
  marketLabel: string;
  subjectKey: string | null;
  subjectLabel: string | null;
  selectionKey: string;
  selectionLabel: string;
  line: number | null;
  americanOdds: number | null;
  available: boolean;
}

/** Raised when the source asks us to slow down or stop (spec §24). */
export class RateLimitSignal extends Error {
  constructor(readonly retryAfterSeconds: number | null, message = 'Sports Bet Montana asked for reduced traffic') {
    super(message);
  }
}

export interface BoardReaderProvider extends Provider {
  /** One request: the index of NFL events. */
  listEvents(ctx: RequestContext): Promise<RawSportsbookEvent[]>;
  /** One request: the markets on a single event page. */
  readEvent(ctx: RequestContext, event: { sourceEventId: string; sourceUrl: string | null; etag: string | null; lastModified: string | null }): Promise<
    { notModified: true } | { notModified: false; markets: RawMarket[]; etag: string | null; lastModified: string | null }
  >;
}

/** Passed into every provider request so budget and cancellation are enforced centrally. */
export interface RequestContext {
  /** Throws if the run's request budget is exhausted (spec §20). */
  spendRequest(label: string): void;
  signal: AbortSignal;
}

// ------------------------------------------------------------- nfl schedule

export interface ScheduleGame {
  providerGameId: string;
  awayTeamAbbrev: string;
  homeTeamAbbrev: string;
  kickoffAt: Date;
  venue: string | null;
  indoor: boolean;
}

export interface ScheduleProvider extends Provider {
  getWeekSchedule(season: number, week: number): Promise<ProviderResult<ScheduleGame[]>>;
}

// ----------------------------------------------------------------- live data

export interface LiveGameState {
  providerGameId: string;
  status: 'SCHEDULED' | 'IN_PROGRESS' | 'FINAL' | 'POSTPONED' | 'CANCELED';
  homeScore: number | null;
  awayScore: number | null;
  quarter: string | null;
  clock: string | null;
}

export interface LivePlayerStat {
  subjectKey: string;
  playerName: string;
  statKey: string;
  value: number;
}

export interface LiveScoreProvider extends Provider {
  getGameStates(providerGameIds: string[]): Promise<ProviderResult<LiveGameState[]>>;
  getPlayerStats(providerGameId: string): Promise<ProviderResult<LivePlayerStat[]>>;
}

// ------------------------------------------------------------------ research

export interface HistoricalStatSample {
  sampleKey: string;
  sampleSize: number;
  hits: number | null;
  value: number | null;
  gameLog: { label: string; value: number; hit: boolean | null }[] | null;
}

export interface StatsProvider extends Provider {
  getPlayerSamples(subjectKey: string, statKey: string, opponentAbbrev: string | null): Promise<ProviderResult<HistoricalStatSample[]>>;
  getDefensiveRanks(teamAbbrev: string, statKey: string): Promise<ProviderResult<{ label: string; value: number; rank: number | null }[]>>;
}

export interface InjuryReport {
  subjectKey: string;
  playerName: string;
  teamAbbrev: string | null;
  position: string | null;
  status: string;
  practiceStatus: string | null;
  detail: string | null;
  reportedAt: Date;
}

export interface InjuryProvider extends Provider {
  getInjuries(teamAbbrevs: string[]): Promise<ProviderResult<InjuryReport[]>>;
}

export interface WeatherForecast {
  indoor: boolean;
  temperatureF: number | null;
  windMph: number | null;
  precipitationChance: number | null;
  conditions: string | null;
  alerts: string | null;
}

export interface WeatherProvider extends Provider {
  getForecast(venue: string, kickoffAt: Date): Promise<ProviderResult<WeatherForecast>>;
}

export interface NewsItem {
  title: string;
  url: string | null;
  publishedAt: Date | null;
  summary: string | null;
  source: string;
}

export interface NewsProvider extends Provider {
  search(query: string, limit: number): Promise<ProviderResult<NewsItem[]>>;
}

export interface AiSummary {
  caseFor: string[];
  caseAgainst: string[];
  bottomLine: string;
  /** Identifiers of the evidence rows the summary was built from (spec §47). */
  sourceRefs: string[];
}

export interface AiResearchProvider extends Provider {
  summarize(input: {
    wagerDescription: string;
    evidence: { kind: string; id: string; text: string; source: string }[];
  }): Promise<ProviderResult<AiSummary>>;
}

// ----------------------------------------------------------------------- OCR

export interface ExtractedTicketLeg {
  legIndex: number;
  descriptionText: string;
  marketKey: string | null;
  subjectLabel: string | null;
  selectionLabel: string | null;
  line: number | null;
  americanOdds: number | null;
  confidence: number;
}

export interface ExtractedTicket {
  legs: ExtractedTicketLeg[];
  combinedAmericanOdds: number | null;
  wagerAmount: number | null;
  potentialPayout: number | null;
  ticketReference: string | null;
  ticketPlacedAt: Date | null;
  rawText: string | null;
  /** Overall confidence 0..1. Low values force human review (spec §55). */
  confidence: number;
}

export interface TicketOcrProvider extends Provider {
  extract(imagePath: string, mimeType: string): Promise<ProviderResult<ExtractedTicket>>;
}
