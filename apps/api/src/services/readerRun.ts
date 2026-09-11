/**
 * The hourly Sports Bet Montana scan (spec §17-§26, §36).
 *
 * Everything in this file exists to make the scan slow, cheap and safe:
 *   - one request at a time, never concurrent (spec §18)
 *   - a long pause between requests (spec §19)
 *   - a hard request budget that ends the run rather than being exceeded (spec §20)
 *   - conditional requests and cached identifiers so unchanged pages cost
 *     almost nothing (spec §21)
 *   - a narrowing focus as the week progresses (spec §23)
 *   - an immediate, non-negotiable stop on any rate-limit signal (spec §24)
 *   - a circuit breaker that makes repeated failure quieter, not louder (spec §25)
 *   - failure isolation, so a bad read never deletes markets or releases
 *     reservations (spec §26, §33)
 */
import { prisma } from '../lib/prisma.js';
import { getReaderSettings } from '../lib/settings.js';
import { audit } from '../lib/audit.js';
import { isMeaningfulChange, selectionKeyOf, type MarketCategory } from '@fcp/shared';
import { RateLimitSignal, type BoardReaderProvider, type RequestContext, type RawMarket } from '../providers/types.js';
import { detectLockedPickIssues } from './marketMonitor.js';

export class BudgetExhausted extends Error {
  constructor(readonly used: number, readonly budget: number) {
    super(`Request budget of ${budget} reached; stopping the scan here.`);
  }
}

export interface RunOptions {
  /** Override the pause between requests. Tests set this to 0. */
  delayMsOverride?: number;
  /** Which week the scan is for; narrows what is worth reading. */
  nflWeekId?: string;
  signal?: AbortSignal;
}

/**
 * Decide how much of the board still needs reading (spec §23).
 * Early in the week everything relevant is fair game so members can shop.
 * Once all ten members are locked, only those exact selections matter.
 */
export async function planScan(nflWeekId: string): Promise<{
  mode: 'BROAD' | 'FOCUSED';
  eventIds: string[];
  reason: string;
}> {
  const [memberCount, reservations] = await Promise.all([
    prisma.user.count({ where: { active: true } }),
    prisma.matchupReservation.count({ where: { nflWeekId } }),
  ]);

  if (memberCount > 0 && reservations >= memberCount) {
    // Everybody is locked: read only the events behind the ten locked picks.
    const locked = await prisma.pick.findMany({
      where: { nflWeekId, state: 'LOCKED' },
      include: { market: { include: { event: true } } },
    });
    const eventIds = [...new Set(locked.map((p) => p.market.event.sourceEventId))];
    return {
      mode: 'FOCUSED',
      eventIds,
      reason: `All ${memberCount} members are locked — monitoring only the ${eventIds.length} events behind those selections.`,
    };
  }

  // Still shopping: prioritise events tied to locked/pending/watched picks,
  // then the remaining unreserved eligible games.
  const [interesting, reserved] = await Promise.all([
    prisma.market.findMany({
      where: {
        OR: [
          { picks: { some: { nflWeekId, state: { in: ['PENDING', 'LOCKED'] } } } },
          { watchedPicks: { some: { nflWeekId } } },
        ],
      },
      include: { event: true },
    }),
    prisma.matchupReservation.findMany({ where: { nflWeekId }, select: { nflGameId: true } }),
  ]);

  const reservedGames = new Set(reserved.map((r) => r.nflGameId));
  const remaining = await prisma.sportsbookEvent.findMany({
    where: {
      OR: [
        // Eligible games nobody has reserved yet: still worth shopping.
        { nflGame: { nflWeekId, eligible: true, status: 'SCHEDULED', id: { notIn: [...reservedGames] } } },
        // Events the board has shown us but that are not matched to a game yet.
        // They came from the NFL index, so they are in scope; skipping them
        // would leave a fresh installation with nothing to read.
        { nflGameId: null, OR: [{ scheduledAt: null }, { scheduledAt: { gte: new Date() } }] },
      ],
    },
  });

  const eventIds = [
    ...new Set([...interesting.map((m) => m.event.sourceEventId), ...remaining.map((e) => e.sourceEventId)]),
  ];
  return {
    mode: 'BROAD',
    eventIds,
    reason: `${reservations}/${memberCount} locked — reading ${eventIds.length} events: committed picks first, then unreserved eligible games.`,
  };
}

/** The circuit breaker decides whether the reader is allowed to run at all (spec §25). */
export async function checkCircuitBreaker(): Promise<{ allowed: boolean; reason: string | null; cooldownUntil: Date | null }> {
  const cb = await prisma.readerCircuitBreaker.upsert({
    where: { id: 'sbm' },
    create: { id: 'sbm' },
    update: {},
  });
  if (cb.cooldownUntil && cb.cooldownUntil > new Date()) {
    return { allowed: false, reason: cb.reason ?? 'Reader paused for safety.', cooldownUntil: cb.cooldownUntil };
  }
  return { allowed: true, reason: null, cooldownUntil: null };
}

/**
 * Repeated failure makes the reader wait longer each time, never shorter.
 * Backoff doubles from 15 minutes and is capped at 6 hours.
 */
export async function recordFailure(reason: string, retryAfterSeconds: number | null): Promise<Date> {
  const cb = await prisma.readerCircuitBreaker.findUniqueOrThrow({ where: { id: 'sbm' } });
  const failures = cb.consecutiveFailures + 1;

  const backoffMs = retryAfterSeconds
    ? retryAfterSeconds * 1000 // the source's own instruction always wins (spec §24)
    : Math.min(15 * 60_000 * 2 ** (failures - 1), 6 * 3_600_000);

  const cooldownUntil = new Date(Date.now() + backoffMs);
  await prisma.readerCircuitBreaker.update({
    where: { id: 'sbm' },
    data: {
      consecutiveFailures: failures,
      openedAt: cb.openedAt ?? new Date(),
      cooldownUntil,
      reason,
    },
  });
  return cooldownUntil;
}

export async function recordSuccess(): Promise<void> {
  await prisma.readerCircuitBreaker.update({
    where: { id: 'sbm' },
    data: { consecutiveFailures: 0, openedAt: null, cooldownUntil: null, reason: null, lastSuccessAt: new Date() },
  });
}

/** A pause of 10-30 seconds between requests. The scan is never in a hurry (spec §19). */
export function sleepBetweenRequests(minMs: number, maxMs: number, override?: number): Promise<void> {
  const ms = override ?? Math.floor(minMs + Math.random() * Math.max(0, maxMs - minMs));
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runScan(reader: BoardReaderProvider, options: RunOptions = {}) {
  const settings = await getReaderSettings();
  const breaker = await checkCircuitBreaker();

  if (!breaker.allowed) {
    return { skipped: true as const, status: 'PAUSED_FOR_SAFETY' as const, reason: breaker.reason, cooldownUntil: breaker.cooldownUntil };
  }
  if (!settings.enabled || !reader.isConfigured()) {
    return {
      skipped: true as const,
      status: 'IDLE' as const,
      reason: 'The Sports Bet Montana reader is switched off or has no address configured.',
      cooldownUntil: null,
    };
  }

  const week = options.nflWeekId
    ? await prisma.nFLWeek.findUnique({ where: { id: options.nflWeekId } })
    : await prisma.nFLWeek.findFirst({
        where: { status: { in: ['IN_PROGRESS', 'ALL_LOCKED', 'ACTION_REQUIRED', 'READY_TO_PLACE'] } },
        orderBy: [{ season: { year: 'desc' } }, { weekNumber: 'asc' }],
      });

  const run = await prisma.readerRun.create({
    data: { nflWeekId: week?.id ?? null, requestBudget: settings.requestBudgetPerRun, status: 'RUNNING' },
  });

  let used = 0;
  const controller = new AbortController();
  if (options.signal) options.signal.addEventListener('abort', () => controller.abort());

  const ctx: RequestContext = {
    signal: controller.signal,
    spendRequest: (label: string) => {
      if (used >= settings.requestBudgetPerRun) throw new BudgetExhausted(used, settings.requestBudgetPerRun);
      used += 1;
      void label;
    },
  };

  const stats = { eventsChecked: 0, marketsActive: 0, marketsChanged: 0, marketsNew: 0, marketsRemoved: 0, marketsRestored: 0, cacheHits: 0 };
  let status: 'COMPLETED' | 'STOPPED_BUDGET' | 'STOPPED_RATE_LIMIT' | 'STOPPED_ERROR' = 'COMPLETED';
  let errorSummary: string | null = null;
  let retryAfterSec: number | null = null;

  try {
    // 1. The event index, once per run.
    const indexEvents = await reader.listEvents(ctx);
    await upsertEvents(indexEvents);
    // Match newly seen sportsbook events to NFL games by team name. This costs
    // no requests: it works purely on data already retrieved.
    await linkEventsToGames(week?.id ?? null);

    // 2. Decide what actually needs reading.
    const plan = week ? await planScan(week.id) : { mode: 'BROAD' as const, eventIds: indexEvents.map((e) => e.sourceEventId), reason: 'No active week.' };
    await prisma.readerRun.update({ where: { id: run.id }, data: { progressNote: plan.reason } });

    const targets = await prisma.sportsbookEvent.findMany({ where: { sourceEventId: { in: plan.eventIds } } });

    // 3. One event at a time, with a long pause between each.
    for (const [index, event] of targets.entries()) {
      await prisma.readerRun.update({
        where: { id: run.id },
        data: { progressNote: `Reading event ${index + 1} of ${targets.length} (${plan.mode.toLowerCase()} scan)` },
      });

      const result = await reader.readEvent(ctx, {
        sourceEventId: event.sourceEventId,
        sourceUrl: event.sourceUrl,
        etag: event.etag,
        lastModified: event.lastModifiedHttp,
      });

      stats.eventsChecked += 1;

      if (result.notModified) {
        // Nothing changed: bump freshness only, write no history (spec §29).
        stats.cacheHits += 1;
        await prisma.sportsbookEvent.update({
          where: { id: event.id },
          data: { lastCheckedAt: new Date(), lastSuccessfulReadAt: new Date() },
        });
        await prisma.market.updateMany({ where: { eventId: event.id }, data: { lastVerifiedAt: new Date() } });
      } else {
        const applied = await applyMarkets(event.id, event.sourceEventId, result.markets, run.id, settings.removalConfirmations);
        stats.marketsActive += applied.active;
        stats.marketsChanged += applied.changed;
        stats.marketsNew += applied.created;
        stats.marketsRemoved += applied.removed;
        stats.marketsRestored += applied.restored;

        await prisma.sportsbookEvent.update({
          where: { id: event.id },
          data: {
            etag: result.etag,
            lastModifiedHttp: result.lastModified,
            lastCheckedAt: new Date(),
            lastSuccessfulReadAt: new Date(),
          },
        });
      }

      if (index < targets.length - 1) {
        await sleepBetweenRequests(settings.minDelayMs, settings.maxDelayMs, options.delayMsOverride);
      }
    }

    await recordSuccess();
  } catch (error) {
    if (error instanceof RateLimitSignal) {
      // Stop the run at once and wait out the cooldown. No retries, no evasion.
      status = 'STOPPED_RATE_LIMIT';
      retryAfterSec = error.retryAfterSeconds;
      errorSummary = error.message;
      const until = await recordFailure(error.message, error.retryAfterSeconds);
      await prisma.readerError.create({ data: { readerRunId: run.id, kind: 'RATE_LIMIT', message: error.message } });
      await audit({
        action: 'READER_RATE_LIMITED',
        entityType: 'ReaderRun',
        entityId: run.id,
        summary: `Sports Bet Montana asked for reduced traffic; reader paused until ${until.toISOString()}.`,
      });
    } else if (error instanceof BudgetExhausted) {
      // Not a failure: the budget did its job (spec §20).
      status = 'STOPPED_BUDGET';
      errorSummary = error.message;
      await recordSuccess();
    } else {
      status = 'STOPPED_ERROR';
      errorSummary = error instanceof Error ? error.message : String(error);
      await recordFailure(errorSummary, null);
      await prisma.readerError.create({ data: { readerRunId: run.id, kind: 'READ_ERROR', message: errorSummary } });
    }
  }

  const finished = await prisma.readerRun.update({
    where: { id: run.id },
    data: {
      status,
      finishedAt: new Date(),
      requestsMade: used,
      rateLimited: status === 'STOPPED_RATE_LIMIT',
      retryAfterSec,
      errorSummary,
      progressNote: null,
      ...stats,
    },
  });

  // Only a scan that actually read pages can change what members are told
  // about their locked picks (spec §33).
  if (week && (status === 'COMPLETED' || status === 'STOPPED_BUDGET')) {
    await detectLockedPickIssues(week.id);
  }

  return { skipped: false as const, run: finished, plan: null };
}

async function upsertEvents(events: { sourceEventId: string; homeTeamName: string; awayTeamName: string; scheduledAt: Date | null; eventStatus: string | null; sourceUrl: string | null }[]) {
  for (const e of events) {
    await prisma.sportsbookEvent.upsert({
      where: { sourceEventId: e.sourceEventId },
      create: {
        sourceEventId: e.sourceEventId,
        homeTeamName: e.homeTeamName,
        awayTeamName: e.awayTeamName,
        scheduledAt: e.scheduledAt,
        eventStatus: e.eventStatus,
        sourceUrl: e.sourceUrl,
        lastCheckedAt: new Date(),
      },
      update: { scheduledAt: e.scheduledAt, eventStatus: e.eventStatus, sourceUrl: e.sourceUrl, lastCheckedAt: new Date() },
    });
  }
}

/**
 * Reconcile one event's markets against what was just read.
 *
 * A selection that is absent from a SUCCESSFUL read is a candidate for removal,
 * but only after `removalConfirmations` consecutive confirmed absences, and
 * only ever because the page parsed — never because a request failed (spec §33).
 */
async function applyMarkets(
  eventId: string,
  sourceEventId: string,
  markets: RawMarket[],
  readerRunId: string,
  removalConfirmations: number,
) {
  const counts = { active: 0, changed: 0, created: 0, removed: 0, restored: 0 };

  // A read that produced nothing is treated as a parse failure, not as the
  // sportsbook emptying its board.
  if (markets.length === 0) {
    await prisma.readerError.create({
      data: { readerRunId, kind: 'PARSE_EMPTY', message: `Event ${sourceEventId} parsed to zero markets; existing data preserved.` },
    });
    return counts;
  }

  const seen = new Set<string>();
  const now = new Date();

  for (const raw of markets) {
    const identity = selectionKeyOf({
      sourceEventId,
      category: raw.category as MarketCategory,
      marketKey: raw.marketKey,
      subjectKey: raw.subjectKey,
      selectionKey: raw.selectionKey,
      line: raw.line,
    });
    seen.add(identity);

    const existing = await prisma.market.findUnique({ where: { selectionIdentity: identity } });

    if (!existing) {
      const created = await prisma.market.create({
        data: {
          eventId,
          sourceMarketId: raw.sourceMarketId,
          category: raw.category,
          marketKey: raw.marketKey,
          marketLabel: raw.marketLabel,
          subjectKey: raw.subjectKey,
          subjectLabel: raw.subjectLabel,
          selectionKey: raw.selectionKey,
          selectionLabel: raw.selectionLabel,
          line: raw.line,
          selectionIdentity: identity,
          americanOdds: raw.americanOdds,
          available: raw.available,
          source: 'SBM_BOARD_READER',
        },
      });
      await prisma.marketSnapshot.create({
        data: { marketId: created.id, americanOdds: raw.americanOdds, line: raw.line, available: raw.available, source: 'SBM_BOARD_READER', readerRunId },
      });
      counts.created += 1;
      counts.active += 1;
      continue;
    }

    const before = { americanOdds: existing.americanOdds, available: existing.available, line: existing.line ? Number(existing.line) : null };
    const after = { americanOdds: raw.americanOdds, available: raw.available, line: raw.line };

    if (isMeaningfulChange(before, after)) {
      await prisma.market.update({
        where: { id: existing.id },
        data: {
          americanOdds: raw.americanOdds,
          available: raw.available,
          lastVerifiedAt: now,
          unavailableSince: raw.available ? null : existing.unavailableSince,
          unavailableConfirmations: raw.available ? 0 : existing.unavailableConfirmations,
        },
      });
      await prisma.marketSnapshot.create({
        data: { marketId: existing.id, americanOdds: raw.americanOdds, line: raw.line, available: raw.available, source: 'SBM_BOARD_READER', readerRunId },
      });
      counts.changed += 1;
      if (!existing.available && raw.available) counts.restored += 1;
    } else {
      // Identical: record only that it was checked (spec §29).
      await prisma.market.update({ where: { id: existing.id }, data: { lastVerifiedAt: now, unavailableConfirmations: 0, unavailableSince: null } });
    }
    counts.active += 1;
  }

  // Selections that were on the board and are now confidently absent.
  const missing = await prisma.market.findMany({
    where: { eventId, available: true, selectionIdentity: { notIn: [...seen] }, source: 'SBM_BOARD_READER' },
  });

  for (const m of missing) {
    const confirmations = m.unavailableConfirmations + 1;
    if (confirmations < removalConfirmations) {
      // Not yet convinced. Nothing is marked unavailable on a single read.
      await prisma.market.update({ where: { id: m.id }, data: { unavailableConfirmations: confirmations } });
      continue;
    }
    await prisma.market.update({
      where: { id: m.id },
      data: { available: false, unavailableSince: m.unavailableSince ?? now, unavailableConfirmations: confirmations },
    });
    await prisma.marketSnapshot.create({
      data: { marketId: m.id, americanOdds: m.americanOdds, line: m.line, available: false, source: 'SBM_BOARD_READER', readerRunId },
    });
    counts.removed += 1;
  }

  return counts;
}


/**
 * Associate sportsbook events with NFL games using team names (spec §27).
 * Purely local work — no additional requests to Sports Bet Montana.
 */
export async function linkEventsToGames(nflWeekId: string | null): Promise<number> {
  const unlinked = await prisma.sportsbookEvent.findMany({ where: { nflGameId: null } });
  if (unlinked.length === 0) return 0;

  const games = await prisma.nFLGame.findMany({
    where: nflWeekId ? { nflWeekId } : { status: 'SCHEDULED' },
    include: { homeTeam: true, awayTeam: true },
  });

  let linked = 0;
  for (const event of unlinked) {
    const match = games.find(
      (g) =>
        teamMatches(g.homeTeam, event.homeTeamName) && teamMatches(g.awayTeam, event.awayTeamName),
    );
    if (!match) continue;
    await prisma.sportsbookEvent.update({ where: { id: event.id }, data: { nflGameId: match.id } });
    linked += 1;
  }
  return linked;
}

function teamMatches(
  team: { abbreviation: string; nickname: string; location: string; aliases: string[] },
  text: string,
): boolean {
  const needle = text.trim().toLowerCase();
  if (!needle) return false;
  return (
    team.abbreviation.toLowerCase() === needle ||
    team.nickname.toLowerCase() === needle ||
    `${team.location} ${team.nickname}`.toLowerCase() === needle ||
    team.aliases.some((a) => a.toLowerCase() === needle)
  );
}
