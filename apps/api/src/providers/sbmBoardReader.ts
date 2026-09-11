/**
 * Sports Bet Montana Public Board Reader (spec §15-§26).
 *
 * Design stance: this reader is deliberately the slowest component in the
 * application. It issues one request at a time, waits 10-30 seconds between
 * them, stops dead at a request budget, and treats any sign of unwelcome
 * traffic as a reason to stop rather than retry. A complete scan taking 20-30
 * minutes is the intended behaviour, not a performance problem (spec §16, §17).
 *
 * The HTTP layer is isolated here so a future official Sports Bet Montana API
 * or feed can replace it without touching anything downstream (spec §15).
 */
import { env } from '../lib/env.js';
import { parseAmerican, normalizeKey } from '@fcp/shared';
import {
  type BoardReaderProvider,
  type RawMarket,
  type RawSportsbookEvent,
  type RequestContext,
  RateLimitSignal,
} from './types.js';

export class SbmBoardReader implements BoardReaderProvider {
  readonly name = 'SPORTS_BET_MONTANA_BOARD_READER';

  constructor(private readonly baseUrl = env.sbm.baseUrl) {}

  isConfigured(): boolean {
    return this.baseUrl.length > 0;
  }

  async listEvents(ctx: RequestContext): Promise<RawSportsbookEvent[]> {
    this.assertConfigured();
    ctx.spendRequest('listEvents');
    // Only the NFL index is ever requested. Other sports, casino content,
    // promotions, account and wallet pages are never fetched (spec §22).
    const res = await this.fetch(`${this.baseUrl}/nfl`, ctx, {});
    if (res.status === 304) return [];
    const body = await res.text();
    return parseEventIndex(body, this.baseUrl);
  }

  async readEvent(
    ctx: RequestContext,
    event: { sourceEventId: string; sourceUrl: string | null; etag: string | null; lastModified: string | null },
  ) {
    this.assertConfigured();
    ctx.spendRequest(`readEvent:${event.sourceEventId}`);

    // Conditional request: if nothing changed, the source sends 304 and no
    // body, which is the cheapest possible interaction (spec §21).
    const headers: Record<string, string> = {};
    if (event.etag) headers['If-None-Match'] = event.etag;
    if (event.lastModified) headers['If-Modified-Since'] = event.lastModified;

    const url = event.sourceUrl ?? `${this.baseUrl}/nfl/event/${event.sourceEventId}`;
    const res = await this.fetch(url, ctx, headers);

    if (res.status === 304) return { notModified: true as const };

    const body = await res.text();
    return {
      notModified: false as const,
      markets: parseEventMarkets(body),
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
    };
  }

  private assertConfigured() {
    if (!this.isConfigured()) {
      throw new Error(
        'The Sports Bet Montana board reader has no address configured. Set SBM_BOARD_BASE_URL once you have written authorization to read the public board.',
      );
    }
  }

  private async fetch(url: string, ctx: RequestContext, headers: Record<string, string>): Promise<Response> {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctx.signal,
      headers: {
        // The reader identifies itself honestly and never disguises itself (spec §24).
        'User-Agent': env.sbm.userAgent,
        Accept: 'text/html,application/json;q=0.9',
        ...headers,
      },
    });

    // Any instruction to reduce traffic stops the run immediately. We never
    // rotate addresses, retry hard, or try to work around the limit (spec §24).
    if (res.status === 429 || res.status === 403 || res.status === 503) {
      const retryAfter = res.headers.get('retry-after');
      throw new RateLimitSignal(
        retryAfter ? Number(retryAfter) || null : null,
        `Sports Bet Montana responded ${res.status}; stopping this run.`,
      );
    }
    if (!res.ok && res.status !== 304) {
      throw new Error(`Sports Bet Montana responded ${res.status} for ${url}`);
    }
    return res;
  }
}

// ---------------------------------------------------------------- parsing
//
// Parsing is kept separate and total: it returns what it can confidently read
// and nothing else. A parse that finds no markets is reported as a parse
// failure upstream and never as "the sportsbook removed its markets" (spec §33).

export function parseEventIndex(body: string, baseUrl: string): RawSportsbookEvent[] {
  const json = tryJson(body);
  if (!json) return [];
  const list = Array.isArray(json) ? json : (json.events ?? json.data ?? []);
  if (!Array.isArray(list)) return [];

  const events: RawSportsbookEvent[] = [];
  for (const raw of list) {
    const sourceEventId = String(raw.id ?? raw.eventId ?? raw.event_id ?? '').trim();
    const homeTeamName = String(raw.home ?? raw.homeTeam ?? raw.home_team ?? '').trim();
    const awayTeamName = String(raw.away ?? raw.awayTeam ?? raw.away_team ?? '').trim();
    if (!sourceEventId || !homeTeamName || !awayTeamName) continue;

    const started = raw.start ?? raw.startTime ?? raw.scheduled ?? raw.commence_time;
    events.push({
      sourceEventId,
      homeTeamName,
      awayTeamName,
      scheduledAt: started ? new Date(started) : null,
      eventStatus: raw.status ? String(raw.status) : null,
      sourceUrl: raw.url ? String(raw.url) : `${baseUrl}/nfl/event/${sourceEventId}`,
    });
  }
  return events;
}

export function parseEventMarkets(body: string): RawMarket[] {
  const json = tryJson(body);
  if (!json) return [];
  const list = Array.isArray(json) ? json : (json.markets ?? json.data ?? []);
  if (!Array.isArray(list)) return [];

  const markets: RawMarket[] = [];
  for (const raw of list) {
    for (const sel of raw.selections ?? raw.outcomes ?? [raw]) {
      const odds = parseAmerican(sel.price ?? sel.odds ?? sel.american ?? null);
      const marketLabel = String(raw.name ?? raw.market ?? sel.market ?? '').trim();
      const selectionLabel = String(sel.name ?? sel.selection ?? sel.label ?? '').trim();
      if (!marketLabel || !selectionLabel) continue;

      const line = numberOrNull(sel.line ?? sel.point ?? sel.handicap ?? raw.line ?? null);
      const subjectLabel = sel.player ?? sel.participant ?? raw.player ?? sel.team ?? null;

      markets.push({
        sourceMarketId: raw.id ? String(raw.id) : null,
        category: categorize(marketLabel, Boolean(sel.player ?? raw.player)),
        marketKey: normalizeKey(marketLabel),
        marketLabel,
        subjectKey: subjectLabel ? normalizeKey(String(subjectLabel)) : null,
        subjectLabel: subjectLabel ? String(subjectLabel) : null,
        selectionKey: normalizeKey(selectionLabel),
        selectionLabel,
        line,
        americanOdds: odds,
        // A selection with no readable price is recorded as unavailable rather
        // than given an invented one.
        available: sel.available === undefined ? odds !== null : Boolean(sel.available),
      });
    }
  }
  return markets;
}

function categorize(marketLabel: string, hasPlayer: boolean): string {
  const l = marketLabel.toLowerCase();
  if (hasPlayer && l.includes('touchdown')) return 'TOUCHDOWN_SCORER';
  if (l.includes('field goal') || l.includes('kicking')) return 'KICKING';
  if (hasPlayer) return 'PLAYER_PROP';
  if (l.includes('team total')) return 'TEAM_TOTAL';
  if (l.includes('moneyline') || l.includes('spread') || l.includes('total')) return 'GAME_LINE';
  return 'GAME_PROP';
}

function numberOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function tryJson(body: string): any | null {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
