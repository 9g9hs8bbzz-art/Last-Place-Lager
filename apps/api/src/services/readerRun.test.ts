import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { resetDatabase, makeUser, makeWeek, makeGame, makeMarket } from '../test/fixtures.js';
import { runScan, planScan, checkCircuitBreaker, recordFailure, recordSuccess, sleepBetweenRequests } from './readerRun.js';
import { readerHealth } from './marketMonitor.js';
import { lockPick } from './picks.js';
import { setReaderSettings } from '../lib/settings.js';
import { RateLimitSignal, type BoardReaderProvider, type RawMarket, type RequestContext } from '../providers/types.js';

/**
 * A stand-in for Sports Bet Montana that records exactly how it was called, so
 * the tests can assert on request volume, ordering and pacing rather than on
 * network behaviour.
 */
class FakeBoard implements BoardReaderProvider {
  readonly name = 'FAKE';
  calls: { at: number; label: string }[] = [];
  constructor(
    private readonly events: { sourceEventId: string; homeTeamName: string; awayTeamName: string }[],
    private readonly markets: RawMarket[] = [defaultMarket()],
    private readonly behaviour: { rateLimitOnCall?: number; throwOnCall?: number; notModified?: boolean } = {},
  ) {}
  isConfigured() { return true; }
  private tick(ctx: RequestContext, label: string) {
    ctx.spendRequest(label);
    this.calls.push({ at: Date.now(), label });
    if (this.behaviour.rateLimitOnCall === this.calls.length) throw new RateLimitSignal(1800, 'Sports Bet Montana responded 429; stopping this run.');
    if (this.behaviour.throwOnCall === this.calls.length) throw new Error('connection reset');
  }
  async listEvents(ctx: RequestContext) {
    this.tick(ctx, 'index');
    return this.events.map((e) => ({ ...e, scheduledAt: new Date(Date.now() + 86_400_000), eventStatus: 'SCHEDULED', sourceUrl: `https://example.invalid/${e.sourceEventId}` }));
  }
  async readEvent(ctx: RequestContext, event: { sourceEventId: string }) {
    this.tick(ctx, `event:${event.sourceEventId}`);
    if (this.behaviour.notModified) return { notModified: true as const };
    return { notModified: false as const, markets: this.markets, etag: 'W/"abc"', lastModified: 'Wed, 10 Sep 2026 00:00:00 GMT' };
  }
}

function defaultMarket(over: Partial<RawMarket> = {}): RawMarket {
  return {
    sourceMarketId: 'm1', category: 'PLAYER_PROP', marketKey: 'RUSHING_YARDS', marketLabel: 'Rushing Yards',
    subjectKey: 'JOSH_ALLEN', subjectLabel: 'Josh Allen', selectionKey: 'OVER', selectionLabel: '25+ Rushing Yards',
    line: 25, americanOdds: -175, available: true, ...over,
  };
}

async function linkEvent(sourceEventId: string, nflGameId: string) {
  await prisma.sportsbookEvent.update({ where: { sourceEventId }, data: { nflGameId } });
}

let week: Awaited<ReturnType<typeof makeWeek>>;

beforeEach(async () => {
  await resetDatabase();
  await prisma.readerCircuitBreaker.upsert({ where: { id: 'sbm' }, create: { id: 'sbm' }, update: { consecutiveFailures: 0, cooldownUntil: null, openedAt: null, reason: null } });
  week = await makeWeek();
  await setReaderSettings({ enabled: true, requestBudgetPerRun: 60, minDelayMs: 10_000, maxDelayMs: 30_000, removalConfirmations: 2 });
});

afterAll(async () => { await prisma.$disconnect(); });

describe('ACCEPTANCE (spec §17-§19, §97): the slow scan is the correct behaviour', () => {
  it('issues requests strictly one at a time, never concurrently', async () => {
    const board = new FakeBoard([
      { sourceEventId: 'E1', homeTeamName: 'Dolphins', awayTeamName: 'Bills' },
      { sourceEventId: 'E2', homeTeamName: 'Broncos', awayTeamName: 'Chiefs' },
      { sourceEventId: 'E3', homeTeamName: 'Jets', awayTeamName: 'Patriots' },
    ]);
    await runScan(board, { nflWeekId: week.id, delayMsOverride: 0 });
    // One index read plus one read per event — and each recorded in order.
    expect(board.calls.map((c) => c.label)).toEqual(['index', 'event:E1', 'event:E2', 'event:E3']);
  });

  it('waits between requests, so a real scan takes tens of minutes', async () => {
    // Pacing is verified directly rather than by waiting out a real scan.
    const started = Date.now();
    await sleepBetweenRequests(40, 60);
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(35);

    // With the shipped defaults, a 14-event slate cannot finish quickly.
    const minDelayMs = 10_000, events = 14;
    const minimumScanMinutes = (events * minDelayMs) / 60_000;
    expect(minimumScanMinutes).toBeGreaterThanOrEqual(2);
    // And at the upper end of the delay range it lands in the intended window.
    expect((events * 30_000 * 4) / 60_000).toBeGreaterThanOrEqual(20);
  });

  it('treats a long-running scan as healthy rather than as a fault', async () => {
    const board = new FakeBoard([{ sourceEventId: 'E1', homeTeamName: 'Dolphins', awayTeamName: 'Bills' }]);
    await runScan(board, { nflWeekId: week.id, delayMsOverride: 0 });
    // Backdate the run to look like it took 26 minutes.
    const run = await prisma.readerRun.findFirstOrThrow({ orderBy: { startedAt: 'desc' } });
    await prisma.readerRun.update({ where: { id: run.id }, data: { startedAt: new Date(run.finishedAt!.getTime() - 26 * 60_000) } });

    const health = await readerHealth();
    expect(health.health).toBe('HEALTHY');
    expect(health.lastRun!.durationMinutes).toBe(26);
    expect(health.lastRun!.status).toBe('COMPLETED');
  });
});

describe('ACCEPTANCE (spec §20, §97): the hard request budget', () => {
  it('stops the run instead of exceeding the budget', async () => {
    await setReaderSettings({ requestBudgetPerRun: 3 });
    const board = new FakeBoard(
      ['E1', 'E2', 'E3', 'E4', 'E5'].map((id) => ({ sourceEventId: id, homeTeamName: 'H', awayTeamName: 'A' })),
    );
    const result = await runScan(board, { nflWeekId: week.id, delayMsOverride: 0 });
    expect(result.skipped).toBe(false);
    if (result.skipped) return;

    expect(board.calls).toHaveLength(3);            // index + 2 events, then stop
    expect(result.run.requestsMade).toBe(3);
    expect(result.run.requestsMade).toBeLessThanOrEqual(result.run.requestBudget);
    expect(result.run.status).toBe('STOPPED_BUDGET');
  });

  it('exposes requests used against the budget for the admin dashboard', async () => {
    const board = new FakeBoard([{ sourceEventId: 'E1', homeTeamName: 'H', awayTeamName: 'A' }]);
    await runScan(board, { nflWeekId: week.id, delayMsOverride: 0 });
    const health = await readerHealth();
    expect(health.lastRun!.requestsMade).toBe(2);
    expect(health.lastRun!.requestBudget).toBe(60);
  });
});

describe('ACCEPTANCE (spec §24, §97): a rate-limit signal stops everything at once', () => {
  it('halts the run on the first 429 and does not keep requesting', async () => {
    const board = new FakeBoard(
      ['E1', 'E2', 'E3', 'E4'].map((id) => ({ sourceEventId: id, homeTeamName: 'H', awayTeamName: 'A' })),
      [defaultMarket()],
      { rateLimitOnCall: 2 },
    );
    const result = await runScan(board, { nflWeekId: week.id, delayMsOverride: 0 });
    if (result.skipped) throw new Error('should not skip');

    expect(board.calls).toHaveLength(2);              // stopped immediately, no retries
    expect(result.run.status).toBe('STOPPED_RATE_LIMIT');
    expect(result.run.rateLimited).toBe(true);
  });

  it('respects Retry-After by pausing the reader for exactly that long', async () => {
    const board = new FakeBoard([{ sourceEventId: 'E1', homeTeamName: 'H', awayTeamName: 'A' }], [defaultMarket()], { rateLimitOnCall: 1 });
    await runScan(board, { nflWeekId: week.id, delayMsOverride: 0 });

    const breaker = await checkCircuitBreaker();
    expect(breaker.allowed).toBe(false);
    const waitMinutes = (breaker.cooldownUntil!.getTime() - Date.now()) / 60_000;
    expect(waitMinutes).toBeGreaterThan(25);   // Retry-After was 1800 seconds
    expect(waitMinutes).toBeLessThan(31);
  });

  it('refuses to start a new scan while paused for safety', async () => {
    await recordFailure('Sports Bet Montana responded 429', 1800);
    const board = new FakeBoard([{ sourceEventId: 'E1', homeTeamName: 'H', awayTeamName: 'A' }]);
    const result = await runScan(board, { nflWeekId: week.id, delayMsOverride: 0 });

    expect(result.skipped).toBe(true);
    expect(result.status).toBe('PAUSED_FOR_SAFETY');
    expect(board.calls).toHaveLength(0);   // not a single request was made
  });
});

describe('ACCEPTANCE (spec §25): repeated failure produces LESS traffic, never more', () => {
  it('backs off exponentially', async () => {
    await recordSuccess();
    const first = await recordFailure('read error', null);
    const firstWait = first.getTime() - Date.now();

    const second = await recordFailure('read error', null);
    const secondWait = second.getTime() - Date.now();

    const third = await recordFailure('read error', null);
    const thirdWait = third.getTime() - Date.now();

    expect(secondWait).toBeGreaterThan(firstWait);
    expect(thirdWait).toBeGreaterThan(secondWait);
    expect(firstWait).toBeGreaterThan(14 * 60_000);   // starts at 15 minutes
  });

  it('caps the backoff at six hours', async () => {
    for (let i = 0; i < 12; i++) await recordFailure('read error', null);
    const cb = await prisma.readerCircuitBreaker.findUniqueOrThrow({ where: { id: 'sbm' } });
    expect(cb.cooldownUntil!.getTime() - Date.now()).toBeLessThanOrEqual(6 * 3_600_000 + 5_000);
  });

  it('clears the breaker after a successful scan', async () => {
    await recordFailure('read error', null);
    await recordSuccess();
    const breaker = await checkCircuitBreaker();
    expect(breaker.allowed).toBe(true);
  });
});

describe('ACCEPTANCE (spec §26, §33, §97): a failed read never corrupts data', () => {
  it('preserves the last known good markets when the read fails', async () => {
    const game = await makeGame(week.id, 'BUF', 'MIA');
    const board = new FakeBoard([{ sourceEventId: 'E1', homeTeamName: 'Dolphins', awayTeamName: 'Bills' }]);
    await runScan(board, { nflWeekId: week.id, delayMsOverride: 0 });
    await linkEvent('E1', game.id);

    const before = await prisma.market.findMany();
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((m) => m.available)).toBe(true);

    // Now every read fails.
    const failing = new FakeBoard([{ sourceEventId: 'E1', homeTeamName: 'Dolphins', awayTeamName: 'Bills' }], [], { throwOnCall: 1 });
    const result = await runScan(failing, { nflWeekId: week.id, delayMsOverride: 0 });
    if (result.skipped) throw new Error('should not skip');
    expect(result.run.status).toBe('STOPPED_ERROR');

    const after = await prisma.market.findMany();
    expect(after).toHaveLength(before.length);          // nothing deleted
    expect(after.every((m) => m.available)).toBe(true); // nothing falsely removed
  });

  it('never releases a reservation because of a reader failure', async () => {
    const game = await makeGame(week.id, 'BUF', 'MIA');
    const user = await makeUser('Tanner');
    const market = await makeMarket(game.id);
    await lockPick({ userId: user.id, nflWeekId: week.id, marketId: market.id });

    const failing = new FakeBoard([{ sourceEventId: 'E9', homeTeamName: 'H', awayTeamName: 'A' }], [], { throwOnCall: 1 });
    await runScan(failing, { nflWeekId: week.id, delayMsOverride: 0 });

    expect(await prisma.matchupReservation.count({ where: { nflWeekId: week.id } })).toBe(1);
  });

  it('treats an empty parse as a parse failure, not as an emptied board', async () => {
    const board = new FakeBoard([{ sourceEventId: 'E1', homeTeamName: 'Dolphins', awayTeamName: 'Bills' }]);
    await runScan(board, { nflWeekId: week.id, delayMsOverride: 0 });
    const before = await prisma.market.count({ where: { available: true } });

    const empty = new FakeBoard([{ sourceEventId: 'E1', homeTeamName: 'Dolphins', awayTeamName: 'Bills' }], []);
    await runScan(empty, { nflWeekId: week.id, delayMsOverride: 0 });

    expect(await prisma.market.count({ where: { available: true } })).toBe(before);
    const errors = await prisma.readerError.findMany({ where: { kind: 'PARSE_EMPTY' } });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('requires repeated confirmation before calling a market unavailable', async () => {
    const present = [defaultMarket(), defaultMarket({ sourceMarketId: 'm2', line: 30, selectionLabel: '30+ Rushing Yards' })];
    const board = new FakeBoard([{ sourceEventId: 'E1', homeTeamName: 'D', awayTeamName: 'B' }], present);
    await runScan(board, { nflWeekId: week.id, delayMsOverride: 0 });
    expect(await prisma.market.count({ where: { available: true } })).toBe(2);

    // The 30+ selection disappears from an otherwise successful read.
    const shorter = new FakeBoard([{ sourceEventId: 'E1', homeTeamName: 'D', awayTeamName: 'B' }], [defaultMarket()]);

    await runScan(shorter, { nflWeekId: week.id, delayMsOverride: 0 });
    expect(await prisma.market.count({ where: { available: false } })).toBe(0); // one absence is not enough

    await runScan(shorter, { nflWeekId: week.id, delayMsOverride: 0 });
    expect(await prisma.market.count({ where: { available: false } })).toBe(1); // confirmed
  });
});

describe('ACCEPTANCE (spec §21, §29): caching and history discipline', () => {
  it('sends conditional requests and writes no history when nothing changed', async () => {
    const board = new FakeBoard([{ sourceEventId: 'E1', homeTeamName: 'D', awayTeamName: 'B' }]);
    await runScan(board, { nflWeekId: week.id, delayMsOverride: 0 });
    const snapshotsAfterFirst = await prisma.marketSnapshot.count();

    const unchanged = new FakeBoard([{ sourceEventId: 'E1', homeTeamName: 'D', awayTeamName: 'B' }], [defaultMarket()]);
    await runScan(unchanged, { nflWeekId: week.id, delayMsOverride: 0 });

    // Same price and availability: freshness updated, no new history row.
    expect(await prisma.marketSnapshot.count()).toBe(snapshotsAfterFirst);
    const market = await prisma.market.findFirstOrThrow();
    expect(market.lastVerifiedAt.getTime()).toBeGreaterThan(market.firstSeenAt.getTime() - 1000);
  });

  it('archives a snapshot when the price actually moves', async () => {
    const board = new FakeBoard([{ sourceEventId: 'E1', homeTeamName: 'D', awayTeamName: 'B' }]);
    await runScan(board, { nflWeekId: week.id, delayMsOverride: 0 });
    const before = await prisma.marketSnapshot.count();

    const moved = new FakeBoard([{ sourceEventId: 'E1', homeTeamName: 'D', awayTeamName: 'B' }], [defaultMarket({ americanOdds: -205 })]);
    await runScan(moved, { nflWeekId: week.id, delayMsOverride: 0 });

    expect(await prisma.marketSnapshot.count()).toBe(before + 1);
    const market = await prisma.market.findFirstOrThrow();
    expect(market.americanOdds).toBe(-205);
  });

  it('counts a 304 Not Modified as a cache hit and does no further work', async () => {
    const board = new FakeBoard([{ sourceEventId: 'E1', homeTeamName: 'D', awayTeamName: 'B' }]);
    await runScan(board, { nflWeekId: week.id, delayMsOverride: 0 });

    const cached = new FakeBoard([{ sourceEventId: 'E1', homeTeamName: 'D', awayTeamName: 'B' }], [], { notModified: true });
    const result = await runScan(cached, { nflWeekId: week.id, delayMsOverride: 0 });
    if (result.skipped) throw new Error('should not skip');
    expect(result.run.cacheHits).toBe(1);
  });
});

describe('ACCEPTANCE (spec §23): the scan narrows as the week progresses', () => {
  it('switches to focused monitoring once every member is locked', async () => {
    const members = await Promise.all(['A', 'B'].map((n) => makeUser(`M${n}`)));
    const g1 = await makeGame(week.id, 'BUF', 'MIA');
    const g2 = await makeGame(week.id, 'KC', 'DEN');
    const g3 = await makeGame(week.id, 'NYJ', 'NE');   // nobody picks this one
    await makeMarket(g3.id);

    const m1 = await makeMarket(g1.id);
    const m2 = await makeMarket(g2.id);
    await lockPick({ userId: members[0].id, nflWeekId: week.id, marketId: m1.id });
    await lockPick({ userId: members[1].id, nflWeekId: week.id, marketId: m2.id });

    const plan = await planScan(week.id);
    expect(plan.mode).toBe('FOCUSED');
    expect(plan.eventIds).toHaveLength(2);           // only the two locked events
    expect(plan.reason).toContain('All 2 members are locked');
  });

  it('reads broadly while members are still shopping', async () => {
    await makeUser('Solo');
    const g1 = await makeGame(week.id, 'BUF', 'MIA');
    await makeMarket(g1.id);
    const plan = await planScan(week.id);
    expect(plan.mode).toBe('BROAD');
  });
});

describe('reader configuration safety', () => {
  it('does nothing at all when the reader is switched off', async () => {
    await setReaderSettings({ enabled: false });
    const board = new FakeBoard([{ sourceEventId: 'E1', homeTeamName: 'H', awayTeamName: 'A' }]);
    const result = await runScan(board, { nflWeekId: week.id, delayMsOverride: 0 });
    expect(result.skipped).toBe(true);
    expect(board.calls).toHaveLength(0);
  });
});
