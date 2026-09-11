import { Prisma, type PickState } from '@prisma/client';
import { prisma, isUniqueViolation } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { getGuideline } from '../lib/settings.js';
import { checkGuideline, isWithinGuideline } from '@fcp/shared';
import { notify } from './notifications.js';

export class PickError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

/** Every state in which a pick still occupies the member's slot for the week. */
const ACTIVE_STATES: PickState[] = ['PENDING', 'LOCKED'];

async function loadWeekForEditing(nflWeekId: string) {
  const week = await prisma.nFLWeek.findUnique({
    where: { id: nflWeekId },
    include: { season: true },
  });
  if (!week) throw new PickError('WEEK_NOT_FOUND', 'That week does not exist.', 404);
  if (week.status === 'WEEK_OFF') {
    throw new PickError('WEEK_OFF', 'This is a scheduled Week Off — no parlay is being played.', 409);
  }
  // Once the official ticket is confirmed, normal member editing ends (spec §13, §57).
  if (week.frozenAt) {
    throw new PickError(
      'WEEK_FROZEN',
      'The official Sports Bet Montana ticket has been confirmed, so picks can no longer be changed.',
      409,
    );
  }
  return week;
}

async function loadSelectableMarket(marketId: string, nflWeekId: string) {
  const market = await prisma.market.findUnique({
    where: { id: marketId },
    include: { event: { include: { nflGame: true } } },
  });
  if (!market) throw new PickError('MARKET_NOT_FOUND', 'That wager is no longer listed.', 404);

  const game = market.event.nflGame;
  if (!game) {
    throw new PickError('MARKET_NOT_LINKED', 'That wager is not linked to an NFL game yet.', 409);
  }
  if (game.nflWeekId !== nflWeekId) {
    throw new PickError('WRONG_WEEK', 'That game is not part of this week.', 409);
  }
  if (!game.eligible) {
    throw new PickError(
      'NOT_ELIGIBLE',
      'NOT ELIGIBLE FOR THIS WEEK\'S PARLAY — this game is outside the eligible slate.',
      409,
    );
  }
  if (game.status !== 'SCHEDULED' || game.kickoffAt <= new Date()) {
    throw new PickError('GAME_STARTED', 'That game has already started.', 409);
  }
  return { market, game };
}

/**
 * Save or replace a member's PENDING pick.
 * A pending pick does NOT reserve the matchup (spec §10) — no MatchupReservation
 * row is created here, and nothing stops another member from locking the game.
 */
export async function setPendingPick(userId: string, nflWeekId: string, marketId: string) {
  await loadWeekForEditing(nflWeekId);
  const { market, game } = await loadSelectableMarket(marketId, nflWeekId);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.pick.findFirst({
      where: { userId, nflWeekId, state: { in: ACTIVE_STATES } },
    });

    if (existing?.state === 'LOCKED') {
      throw new PickError(
        'ALREADY_LOCKED',
        'You already have a locked pick this week. Unlock it first to choose a different wager.',
        409,
      );
    }

    if (existing) {
      await tx.pickChange.create({
        data: {
          pickId: existing.id,
          changeKind: 'PENDING_SELECTION_CHANGED',
          fromValue: existing.marketId,
          toValue: marketId,
        },
      });
      return tx.pick.update({
        where: { id: existing.id },
        data: { marketId, nflGameId: game.id },
        include: { market: true, nflGame: true },
      });
    }

    return tx.pick.create({
      data: { userId, nflWeekId, nflGameId: game.id, marketId, state: 'PENDING' },
      include: { market: true, nflGame: true },
    });
  });
}

export async function removePendingPick(userId: string, nflWeekId: string) {
  await loadWeekForEditing(nflWeekId);
  const pick = await prisma.pick.findFirst({ where: { userId, nflWeekId, state: 'PENDING' } });
  if (!pick) throw new PickError('NO_PENDING_PICK', 'You do not have a pending pick to remove.', 404);
  await prisma.pick.update({ where: { id: pick.id }, data: { state: 'RELEASED', releasedAt: new Date() } });
  return { removed: true };
}

type LockedPickRecord = Prisma.PickGetPayload<{
  include: {
    market: true;
    nflGame: { include: { homeTeam: true; awayTeam: true } };
    reservation: true;
  };
}>;

export interface LockResult {
  pick: LockedPickRecord;
  outsideGuideline: boolean;
  guidelineMessage: string | null;
}

/**
 * LOCK PICK — reserve this NFL matchup for this member (spec §12).
 *
 * Race safety (spec §8): the reservation is a real row guarded by a unique
 * index on (nflWeekId, nflGameId). Two members pressing LOCK at the same
 * instant both reach the INSERT; Postgres admits exactly one and raises a
 * unique violation for the other, which we translate into a friendly message.
 * The check is never a read-then-write in application code, because that would
 * leave a window between the read and the write.
 *
 * `acknowledgeOutsideGuideline` carries the member's "SELECT ANYWAY" answer.
 * The guideline is advisory: a price outside the range is allowed either way,
 * and is simply recorded on the pick (spec §30).
 */
export async function lockPick(params: {
  userId: string;
  nflWeekId: string;
  marketId: string;
  acknowledgeOutsideGuideline?: boolean;
}): Promise<LockResult> {
  const { userId, nflWeekId, marketId } = params;
  await loadWeekForEditing(nflWeekId);
  const { market, game } = await loadSelectableMarket(marketId, nflWeekId);

  if (market.americanOdds === null) {
    throw new PickError('NO_PRICE', 'That wager has no current Sports Bet Montana price, so it cannot be locked yet.', 409);
  }
  if (!market.available) {
    throw new PickError('MARKET_UNAVAILABLE', 'That wager is not currently available at Sports Bet Montana.', 409);
  }

  const guideline = await getGuideline();
  const within = isWithinGuideline(market.americanOdds, guideline);
  const warning = checkGuideline(market.americanOdds, guideline);

  const locked = await prisma
    .$transaction(async (tx) => {
      const existing = await tx.pick.findFirst({
        where: { userId, nflWeekId, state: { in: ACTIVE_STATES } },
      });
      if (existing?.state === 'LOCKED') {
        throw new PickError(
          'ALREADY_LOCKED',
          'You already have a locked pick this week. Unlock it first to choose a different matchup.',
          409,
        );
      }

      const lockedAt = new Date();
      const snapshot = {
        state: 'LOCKED' as const,
        nflGameId: game.id,
        marketId: market.id,
        lockedAt,
        // The locked snapshot. Later sportsbook movement must never overwrite
        // these values (spec §12, §86).
        lockedAmericanOdds: market.americanOdds,
        lockedLine: market.line,
        lockedSelectionText: `${market.subjectLabel ?? ''} ${market.selectionLabel}`.trim(),
        lockedMarketSourceId: market.sourceMarketId,
        lockedSource: market.source,
        outsideGuidelineAtLock: !within,
      };

      const pick = existing
        ? await tx.pick.update({ where: { id: existing.id }, data: snapshot })
        : await tx.pick.create({ data: { userId, nflWeekId, ...snapshot } });

      // The database decides the race, not this process.
      await tx.matchupReservation.create({
        data: { nflWeekId, nflGameId: game.id, userId, pickId: pick.id },
      });

      await tx.pickChange.create({
        data: { pickId: pick.id, changeKind: 'LOCKED', toValue: market.selectionIdentity },
      });

      return tx.pick.findUniqueOrThrow({
        where: { id: pick.id },
        include: { market: true, nflGame: { include: { homeTeam: true, awayTeam: true } }, reservation: true },
      });
    })
    .catch(async (error: unknown) => {
      if (isUniqueViolation(error, 'nflGameId')) {
        const holder = await prisma.matchupReservation.findUnique({
          where: { nflWeekId_nflGameId: { nflWeekId, nflGameId: game.id } },
          include: { user: true },
        });
        throw new PickError(
          'MATCHUP_TAKEN',
          'This matchup was just reserved by another member. Please choose another game.',
          409,
          { reservedBy: holder?.user.displayName ?? null },
        );
      }
      if (isUniqueViolation(error, 'userId')) {
        throw new PickError('ALREADY_RESERVED', 'You already hold a matchup reservation for this week.', 409);
      }
      throw error;
    });

  await audit({
    actorId: userId,
    action: 'PICK_LOCKED',
    entityType: 'Pick',
    entityId: locked.id,
    summary: `Locked ${locked.market.selectionLabel} and reserved ${game.id}`,
    detail: { americanOdds: market.americanOdds, outsideGuideline: !within },
  });

  // Everyone else learns the matchup is gone (spec §89).
  await notifyMatchupTaken(nflWeekId, game.id, userId);

  return { pick: locked, outsideGuideline: !within, guidelineMessage: warning.message };
}

/**
 * UNLOCK — immediately release the matchup back to the group (spec §13).
 * The pick's change history is preserved; only the reservation disappears.
 */
export async function unlockPick(userId: string, nflWeekId: string) {
  await loadWeekForEditing(nflWeekId);

  const pick = await prisma.pick.findFirst({ where: { userId, nflWeekId, state: 'LOCKED' } });
  if (!pick) throw new PickError('NO_LOCKED_PICK', 'You do not have a locked pick this week.', 404);

  await prisma.$transaction(async (tx) => {
    await tx.matchupReservation.deleteMany({ where: { nflWeekId, userId } });
    await tx.pick.update({
      where: { id: pick.id },
      data: { state: 'PENDING', lockedAt: null, marketUnavailableAt: null, unavailableAckAt: null },
    });
    await tx.pickChange.create({ data: { pickId: pick.id, changeKind: 'UNLOCKED' } });
  });

  await audit({
    actorId: userId,
    action: 'PICK_UNLOCKED',
    entityType: 'Pick',
    entityId: pick.id,
    summary: 'Unlocked pick and released matchup reservation',
  });

  return { released: true, nflGameId: pick.nflGameId };
}

async function notifyMatchupTaken(nflWeekId: string, nflGameId: string, byUserId: string) {
  const [game, taker, affected] = await Promise.all([
    prisma.nFLGame.findUnique({ where: { id: nflGameId }, include: { homeTeam: true, awayTeam: true } }),
    prisma.user.findUnique({ where: { id: byUserId } }),
    // Only members whose own pending pick just became unlockable need to know (spec §10).
    prisma.pick.findMany({ where: { nflWeekId, nflGameId, state: 'PENDING', userId: { not: byUserId } } }),
  ]);
  if (!game || !taker) return;
  const label = `${game.awayTeam.nickname} @ ${game.homeTeam.nickname}`;
  for (const pick of affected) {
    await notify({
      userId: pick.userId,
      kind: 'MATCHUP_TAKEN',
      title: 'MATCHUP TAKEN',
      body: `${label} was reserved by ${taker.displayName}. Your pending pick on this game can no longer be locked — choose another game.`,
      dedupeKey: `matchup-taken:${nflWeekId}:${nflGameId}`,
    });
  }
}

/** Members may only ever act on their own active picks (spec §93). */
export async function assertOwnsPick(userId: string, pickId: string) {
  const pick = await prisma.pick.findUnique({ where: { id: pickId } });
  if (!pick) throw new PickError('PICK_NOT_FOUND', 'That pick does not exist.', 404);
  if (pick.userId !== userId) throw new PickError('FORBIDDEN', 'You can only change your own pick.', 403);
  return pick;
}

export { Prisma };
