/**
 * THE SWEAT — live parlay tracking and automatic grading (spec §59-§63).
 *
 * Grading always uses the OFFICIAL TICKET version of a wager, never the
 * member's locked pick, because the ticket is what was actually placed
 * (spec §62). Anything the app cannot determine confidently is handed to an
 * administrator as AWAITING MANUAL GRADING rather than guessed.
 */
import { prisma } from '../lib/prisma.js';
import { gradeLeg, remainingToHit, type GradableMarket, type Side } from '@fcp/shared';
import { audit } from '../lib/audit.js';
import { notify } from './notifications.js';
import { recomputeWeekStatus } from './weeks.js';
import type { LiveScoreProvider } from '../providers/types.js';
import { isDataUnavailable } from '@fcp/shared';

/** Map a stored market key onto the grading engine's vocabulary. */
export function classifyMarket(marketKey: string | null, category?: string | null): GradableMarket | null {
  const k = (marketKey ?? '').toUpperCase();
  if (k.includes('MONEYLINE')) return 'MONEYLINE';
  if (k.includes('SPREAD')) return 'SPREAD';
  if (k.includes('TEAM_TOTAL')) return 'TEAM_TOTAL';
  if (k.includes('TOTAL')) return 'GAME_TOTAL';
  if (k.includes('TOUCHDOWN') || k.includes('ATD')) return 'ANYTIME_TOUCHDOWN';
  if (
    k.includes('YARDS') || k.includes('RECEPTIONS') || k.includes('COMPLETIONS') ||
    k.includes('PASS_TDS') || k.includes('INTERCEPTIONS') || k.includes('FGS') || k.includes('FIELD_GOALS')
  ) {
    return 'PLAYER_THRESHOLD';
  }
  if (category === 'PLAYER_PROP') return 'PLAYER_THRESHOLD';
  return null;
}

export function classifySide(selectionLabel: string | null): Side {
  const s = (selectionLabel ?? '').toUpperCase();
  if (s.includes('UNDER')) return 'UNDER';
  if (s.includes('OVER') || s.includes('+')) return 'OVER';
  return 'YES';
}

/**
 * Grade one official leg from an observed statistic.
 * `actual` is whatever the market is measured in: the selected team's final
 * margin for a spread/moneyline, combined points for a total, the player's
 * statistic for a prop.
 */
export async function gradeOfficialLeg(legId: string, actual: number | null, opts: { automatic?: boolean; actorId?: string } = {}) {
  const leg = await prisma.officialTicketLeg.findUniqueOrThrow({ where: { id: legId } });
  const market = classifyMarket(leg.marketKey);

  if (!market) {
    await prisma.officialTicketLeg.update({
      where: { id: legId },
      data: { awaitingManualGrading: true, actualValue: actual },
    });
    return { result: 'PENDING' as const, awaitingManualGrading: true };
  }

  const graded = gradeLeg({
    market,
    side: classifySide(leg.selectionLabel),
    line: leg.line === null ? null : Number(leg.line),
    actual,
  });

  if (graded.requiresManualGrading) {
    await prisma.officialTicketLeg.update({
      where: { id: legId },
      data: { awaitingManualGrading: true, actualValue: actual },
    });
    return { result: 'PENDING' as const, awaitingManualGrading: true };
  }

  const previous = leg.result;
  const updated = await prisma.officialTicketLeg.update({
    where: { id: legId },
    data: {
      result: graded.result as never,
      actualValue: actual,
      margin: graded.margin,
      resultNarrative: graded.narrative,
      gradedAt: new Date(),
      gradedManually: !opts.automatic,
      awaitingManualGrading: false,
    },
  });

  if (previous !== updated.result) {
    await prisma.resultAudit.create({
      data: {
        legId,
        actorId: opts.actorId ?? null,
        fromResult: previous,
        toResult: updated.result,
        automatic: Boolean(opts.automatic),
        reason: graded.narrative,
      },
    });
    if (updated.userId && (updated.result === 'WIN' || updated.result === 'LOSS')) {
      await notify({
        userId: updated.userId,
        kind: 'RESULT',
        title: 'RESULT',
        body: `Your wager ${updated.result === 'WIN' ? 'won' : 'lost'}. ${graded.narrative ?? ''}`.trim(),
        dedupeKey: `result:${legId}`,
      });
    }
  }

  return { result: updated.result, awaitingManualGrading: false, margin: graded.margin, narrative: graded.narrative };
}

/** An administrator sets a result by hand, with the reason recorded (spec §62). */
export async function manuallyGradeLeg(params: {
  legId: string;
  result: 'WIN' | 'LOSS' | 'PUSH' | 'VOID';
  actorId: string;
  reason: string;
  actualValue?: number | null;
}) {
  const leg = await prisma.officialTicketLeg.findUniqueOrThrow({ where: { id: params.legId } });
  const updated = await prisma.officialTicketLeg.update({
    where: { id: params.legId },
    data: {
      result: params.result,
      actualValue: params.actualValue ?? leg.actualValue,
      gradedAt: new Date(),
      gradedManually: true,
      awaitingManualGrading: false,
      resultNarrative: params.reason,
    },
  });
  await prisma.resultAudit.create({
    data: { legId: params.legId, actorId: params.actorId, fromResult: leg.result, toResult: params.result, automatic: false, reason: params.reason },
  });
  await audit({
    actorId: params.actorId,
    action: 'LEG_MANUALLY_GRADED',
    entityType: 'OfficialTicketLeg',
    entityId: params.legId,
    summary: `Leg ${leg.legIndex} graded ${params.result}: ${params.reason}`,
  });
  return updated;
}

/** Refresh game states and settle the parlay when everything is decided. */
export async function refreshLive(nflWeekId: string, provider: LiveScoreProvider) {
  const games = await prisma.nFLGame.findMany({ where: { nflWeekId } });
  if (games.length === 0) return { updated: 0, available: false as const };

  if (!provider.isConfigured()) return { updated: 0, available: false as const };

  const states = await provider.getGameStates(games.map((g) => g.providerGameId));
  if (isDataUnavailable(states)) return { updated: 0, available: false as const, reason: states.reason };

  let updated = 0;
  for (const s of states.data) {
    const game = games.find((g) => g.providerGameId === s.providerGameId);
    if (!game) continue;
    await prisma.nFLGame.update({
      where: { id: game.id },
      data: { status: s.status, homeScore: s.homeScore, awayScore: s.awayScore, quarter: s.quarter, clock: s.clock },
    });
    updated += 1;
  }

  await settleParlayIfComplete(nflWeekId);
  await recomputeWeekStatus(nflWeekId);
  return { updated, available: true as const };
}

/** THE SWEAT view model (spec §59-§61). */
export async function sweatBoard(nflWeekId: string) {
  const ticket = await prisma.officialTicket.findUnique({
    where: { nflWeekId },
    include: {
      legs: {
        orderBy: { legIndex: 'asc' },
        include: {
          user: true,
          pick: { include: { nflGame: { include: { homeTeam: true, awayTeam: true } } } },
        },
      },
      week: { include: { parlay: true } },
    },
  });

  if (!ticket || ticket.status !== 'CONFIRMED') {
    return { available: false as const, reason: 'The official parlay for this week has not been confirmed yet.' };
  }

  const legs = ticket.legs.map((leg) => {
    const game = leg.pick?.nflGame;
    const market = classifyMarket(leg.marketKey);
    const progress =
      market && leg.actualValue !== null
        ? remainingToHit({
            market,
            side: classifySide(leg.selectionLabel),
            line: leg.line === null ? null : Number(leg.line),
            actual: Number(leg.actualValue),
          })
        : null;

    let state: 'WON' | 'LOST' | 'PUSH' | 'VOID' | 'LIVE' | 'NOT_STARTED';
    if (leg.result === 'WIN') state = 'WON';
    else if (leg.result === 'LOSS') state = 'LOST';
    else if (leg.result === 'PUSH') state = 'PUSH';
    else if (leg.result === 'VOID') state = 'VOID';
    else if (game?.status === 'IN_PROGRESS') state = 'LIVE';
    else state = 'NOT_STARTED';

    return {
      legIndex: leg.legIndex,
      bettor: leg.user?.displayName ?? 'Unassigned',
      description: leg.descriptionText,
      americanOdds: leg.americanOdds,
      state,
      current: leg.actualValue === null ? null : Number(leg.actualValue),
      needed: progress?.text ?? null,
      narrative: leg.resultNarrative,
      awaitingManualGrading: leg.awaitingManualGrading,
      matchup: game ? `${game.awayTeam.nickname} @ ${game.homeTeam.nickname}` : null,
      gameStatus: game?.status ?? null,
      quarter: game?.quarter ?? null,
      clock: game?.clock ?? null,
    };
  });

  const counts = {
    won: legs.filter((l) => l.state === 'WON').length,
    lost: legs.filter((l) => l.state === 'LOST').length,
    live: legs.filter((l) => l.state === 'LIVE').length,
    notStarted: legs.filter((l) => l.state === 'NOT_STARTED').length,
  };

  // The final-leg screen (spec §61).
  const undecided = legs.filter((l) => l.state === 'LIVE' || l.state === 'NOT_STARTED');
  const finalLeg = counts.lost === 0 && undecided.length === 1 ? undecided[0] : null;

  return {
    available: true as const,
    counts,
    legs,
    finalLeg,
    parlay: {
      combinedAmericanOdds: ticket.combinedAmericanOdds,
      wagerAmount: ticket.wagerAmount ? Number(ticket.wagerAmount) : null,
      potentialPayout: ticket.potentialPayout ? Number(ticket.potentialPayout) : null,
      settled: ticket.week.parlay?.settled ?? false,
      won: ticket.week.parlay?.won ?? null,
    },
  };
}

/** Close out the week once no leg is still undecided. */
export async function settleParlayIfComplete(nflWeekId: string) {
  const ticket = await prisma.officialTicket.findUnique({ where: { nflWeekId }, include: { legs: true } });
  if (!ticket || ticket.status !== 'CONFIRMED') return null;

  const undecided = ticket.legs.filter((l) => l.result === 'PENDING');
  if (undecided.length > 0 || ticket.legs.length === 0) return null;

  const legsWon = ticket.legs.filter((l) => l.result === 'WIN').length;
  const legsLost = ticket.legs.filter((l) => l.result === 'LOSS').length;
  const legsPush = ticket.legs.filter((l) => l.result === 'PUSH' || l.result === 'VOID').length;

  const parlay = await prisma.parlay.upsert({
    where: { nflWeekId },
    create: { nflWeekId, legsWon, legsLost, legsPush, settled: true, won: legsLost === 0, settledAt: new Date() },
    update: { legsWon, legsLost, legsPush, settled: true, won: legsLost === 0, settledAt: new Date() },
  });

  await prisma.nFLWeek.update({ where: { id: nflWeekId }, data: { status: 'SETTLED' } });
  await audit({
    action: 'PARLAY_SETTLED',
    entityType: 'Parlay',
    entityId: parlay.id,
    summary: `Parlay settled ${legsWon}/${ticket.legs.length}${legsLost === 0 ? ' — WON' : ''}`,
  });
  return parlay;
}
