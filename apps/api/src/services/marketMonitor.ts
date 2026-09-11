/**
 * Watching what happens to picks members have already committed to
 * (spec §31, §32, §89).
 *
 * Two rules govern everything here:
 *   1. Nothing in this file ever unlocks a pick, changes a wager, or releases a
 *      matchup. It only tells people what happened.
 *   2. A market is reported unavailable only when its absence was actually
 *      confirmed by a successful read (spec §33).
 */
import { prisma } from '../lib/prisma.js';
import { assessMovement, formatAmerican } from '@fcp/shared';
import { getGuideline } from '../lib/settings.js';
import { notify } from './notifications.js';
import { recomputeWeekStatus } from './weeks.js';

export async function detectLockedPickIssues(nflWeekId: string) {
  const guideline = await getGuideline();
  const locked = await prisma.pick.findMany({
    where: { nflWeekId, state: 'LOCKED' },
    include: {
      market: true,
      user: true,
      nflGame: { include: { homeTeam: true, awayTeam: true } },
    },
  });

  const findings = { movementAlerts: 0, unavailableAlerts: 0, restored: 0 };

  for (const pick of locked) {
    const matchup = `${pick.nflGame.awayTeam.nickname} @ ${pick.nflGame.homeTeam.nickname}`;

    // --- the exact selection is gone (spec §32) -----------------------------
    if (!pick.market.available && pick.market.unavailableSince) {
      if (!pick.marketUnavailableAt) {
        await prisma.pick.update({ where: { id: pick.id }, data: { marketUnavailableAt: new Date() } });
        await notify({
          userId: pick.userId,
          kind: 'MARKET_UNAVAILABLE',
          title: 'ACTION REQUIRED',
          body:
            `Your locked wager (${pick.lockedSelectionText ?? pick.market.selectionLabel}) is no longer available at Sports Bet Montana. ` +
            `Your ${matchup} matchup is still reserved for you — choose another wager from this matchup, or unlock the matchup.`,
          dedupeKey: `market-unavailable:${pick.id}`,
        });
        findings.unavailableAlerts += 1;
      }
      // The reservation is deliberately untouched.
      continue;
    }

    // --- the selection came back --------------------------------------------
    if (pick.market.available && pick.marketUnavailableAt) {
      await prisma.pick.update({ where: { id: pick.id }, data: { marketUnavailableAt: null, unavailableAckAt: null } });
      findings.restored += 1;
    }

    // --- price movement (spec §31) ------------------------------------------
    if (pick.lockedAmericanOdds !== null && pick.market.americanOdds !== null) {
      const movement = assessMovement(pick.lockedAmericanOdds, pick.market.americanOdds, guideline);
      if (movement.shouldAlert && movement.message) {
        await notify({
          userId: pick.userId,
          kind: movement.crossedIntoOutsideGuideline ? 'ODDS_GUIDELINE' : 'ODDS_MOVEMENT',
          title: movement.crossedIntoOutsideGuideline ? 'ODDS GUIDELINE' : 'ODDS MOVEMENT',
          body: movement.message,
          // Keyed by the current price so each distinct move alerts once.
          dedupeKey: `movement:${pick.id}:${pick.market.americanOdds}`,
        });
        findings.movementAlerts += 1;
      }
    }
  }

  await recomputeWeekStatus(nflWeekId);
  return findings;
}

/** Line history for a selection, most recent first (spec §29, §50). */
export async function marketHistory(marketId: string, limit = 50) {
  return prisma.marketSnapshot.findMany({
    where: { marketId },
    orderBy: { observedAt: 'desc' },
    take: limit,
  });
}

/** Per-member readiness for the admin dashboard (spec §53). */
export async function parlayReadiness(nflWeekId: string) {
  const guideline = await getGuideline();
  const [members, picks] = await Promise.all([
    prisma.user.findMany({ where: { active: true }, orderBy: { displayName: 'asc' } }),
    prisma.pick.findMany({
      where: { nflWeekId, state: 'LOCKED' },
      include: { market: true, nflGame: { include: { homeTeam: true, awayTeam: true } } },
    }),
  ]);

  const byUser = new Map(picks.map((p) => [p.userId, p]));

  return members.map((member) => {
    const pick = byUser.get(member.id);
    if (!pick) {
      return {
        userId: member.id,
        displayName: member.displayName,
        matchupReserved: false,
        exactMarketAvailable: null,
        withinOddsGuideline: null,
        lockedOdds: null,
        currentOdds: null,
        actionRequired: true,
        notes: ['No locked pick yet'],
      };
    }

    const current = pick.market.americanOdds;
    const available = pick.market.available && !pick.marketUnavailableAt;
    const within =
      current === null ? null : current >= guideline.minAmerican && current <= guideline.maxAmerican;

    const notes: string[] = [];
    if (!available) notes.push('Exact market unavailable — ACTION REQUIRED');
    if (within === false) notes.push(`Outside odds guideline (${formatAmerican(current)})`);
    if (available && within !== false) notes.push('Ready');

    return {
      userId: member.id,
      displayName: member.displayName,
      matchup: `${pick.nflGame.awayTeam.nickname} @ ${pick.nflGame.homeTeam.nickname}`,
      selection: pick.lockedSelectionText ?? pick.market.selectionLabel,
      matchupReserved: true,
      exactMarketAvailable: available,
      withinOddsGuideline: within,
      lockedOdds: pick.lockedAmericanOdds,
      currentOdds: current,
      actionRequired: !available,
      notes,
    };
  });
}

/** Reader health for the admin dashboard (spec §26, §36). */
export async function readerHealth() {
  const [lastRun, lastSuccess, breaker, activeMarkets, recentErrors] = await Promise.all([
    prisma.readerRun.findFirst({ orderBy: { startedAt: 'desc' } }),
    prisma.readerRun.findFirst({ where: { status: 'COMPLETED' }, orderBy: { startedAt: 'desc' } }),
    prisma.readerCircuitBreaker.findUnique({ where: { id: 'sbm' } }),
    prisma.market.count({ where: { available: true } }),
    prisma.readerError.findMany({ orderBy: { occurredAt: 'desc' }, take: 20 }),
  ]);

  const pausedUntil = breaker?.cooldownUntil && breaker.cooldownUntil > new Date() ? breaker.cooldownUntil : null;
  const lastSuccessAt = lastSuccess?.finishedAt ?? null;
  const ageMs = lastSuccessAt ? Date.now() - lastSuccessAt.getTime() : null;

  let health: 'HEALTHY' | 'STALE' | 'PARTIAL' | 'ERROR' | 'PAUSED_FOR_SAFETY';
  if (pausedUntil) health = 'PAUSED_FOR_SAFETY';
  // Never having run is not a failure: it is a reader that has not been
  // switched on yet. Only an actual failed run is reported as ERROR.
  else if (!lastRun) health = 'STALE';
  else if (!lastSuccessAt) health = lastRun.status === 'STOPPED_ERROR' || lastRun.status === 'STOPPED_RATE_LIMIT' ? 'ERROR' : 'STALE';
  else if (lastRun?.status === 'STOPPED_BUDGET') health = 'PARTIAL';
  else if (lastRun?.status === 'STOPPED_ERROR' || lastRun?.status === 'STOPPED_RATE_LIMIT') health = 'ERROR';
  else if (ageMs !== null && ageMs > 2 * 3_600_000) health = 'STALE';
  else health = 'HEALTHY';

  return {
    health,
    neverRun: lastRun === null,
    // A scan taking 20-30 minutes is normal, so duration is reported plainly
    // rather than flagged (spec §36).
    currentRun: lastRun && !lastRun.finishedAt ? {
      id: lastRun.id,
      startedAt: lastRun.startedAt,
      progressNote: lastRun.progressNote,
      requestsMade: lastRun.requestsMade,
      requestBudget: lastRun.requestBudget,
      elapsedMinutes: Math.round((Date.now() - lastRun.startedAt.getTime()) / 60_000),
    } : null,
    lastRun: lastRun ? {
      id: lastRun.id,
      status: lastRun.status,
      startedAt: lastRun.startedAt,
      finishedAt: lastRun.finishedAt,
      durationMinutes: lastRun.finishedAt ? Math.round((lastRun.finishedAt.getTime() - lastRun.startedAt.getTime()) / 60_000) : null,
      requestsMade: lastRun.requestsMade,
      requestBudget: lastRun.requestBudget,
      eventsChecked: lastRun.eventsChecked,
      marketsActive: lastRun.marketsActive,
      marketsChanged: lastRun.marketsChanged,
      marketsNew: lastRun.marketsNew,
      marketsRemoved: lastRun.marketsRemoved,
      marketsRestored: lastRun.marketsRestored,
      cacheHits: lastRun.cacheHits,
      errorSummary: lastRun.errorSummary,
    } : null,
    lastSuccessfulScanAt: lastSuccessAt,
    circuitBreaker: {
      open: Boolean(pausedUntil),
      consecutiveFailures: breaker?.consecutiveFailures ?? 0,
      cooldownUntil: pausedUntil,
      reason: breaker?.reason ?? null,
    },
    activeMarkets,
    recentErrors,
  };
}
