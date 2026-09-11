import { prisma } from '../lib/prisma.js';
import type { MatchupState, WeekStatus } from '@fcp/shared';
import { audit } from '../lib/audit.js';

/** How a single game appears to one member (spec §9). */
export async function matchupStatesForWeek(nflWeekId: string, viewerId: string) {
  const [games, reservations, myPick] = await Promise.all([
    prisma.nFLGame.findMany({
      where: { nflWeekId },
      include: { homeTeam: true, awayTeam: true },
      orderBy: { kickoffAt: 'asc' },
    }),
    prisma.matchupReservation.findMany({ where: { nflWeekId }, include: { user: true } }),
    prisma.pick.findFirst({ where: { nflWeekId, userId: viewerId, state: { in: ['PENDING', 'LOCKED'] } } }),
  ]);

  const byGame = new Map(reservations.map((r) => [r.nflGameId, r]));
  const now = new Date();

  return games.map((game) => {
    const reservation = byGame.get(game.id);
    let state: MatchupState;
    let reservedBy: string | null = null;

    if (!game.eligible) {
      state = 'NOT_ELIGIBLE';
    } else if (game.status === 'FINAL' || game.status === 'CANCELED') {
      state = 'CLOSED';
    } else if (game.status === 'IN_PROGRESS' || game.kickoffAt <= now) {
      state = 'STARTED';
    } else if (reservation) {
      if (reservation.userId === viewerId) {
        state = 'MY_RESERVED_GAME';
      } else {
        state = 'RESERVED_BY_OTHER';
        reservedBy = reservation.user.displayName;
      }
    } else if (myPick?.state === 'PENDING' && myPick.nflGameId === game.id) {
      state = 'MY_PENDING_GAME';
    } else {
      state = 'AVAILABLE';
    }

    return {
      id: game.id,
      providerGameId: game.providerGameId,
      away: game.awayTeam.nickname,
      home: game.homeTeam.nickname,
      awayAbbrev: game.awayTeam.abbreviation,
      homeAbbrev: game.homeTeam.abbreviation,
      label: `${game.awayTeam.nickname} @ ${game.homeTeam.nickname}`,
      kickoffAt: game.kickoffAt,
      status: game.status,
      eligible: game.eligible,
      eligibilityNote: game.eligibilityNote,
      indoor: game.indoor,
      state,
      reservedBy,
      selectable: state === 'AVAILABLE' || state === 'MY_PENDING_GAME' || state === 'MY_RESERVED_GAME',
      homeScore: game.homeScore,
      awayScore: game.awayScore,
    };
  });
}

/**
 * The week's parlay board. Another member's PENDING pick is never revealed —
 * only that they have not locked yet (spec §5, §10).
 */
export async function weekBoard(nflWeekId: string, viewerId: string) {
  const [week, members, picks, reservations] = await Promise.all([
    prisma.nFLWeek.findUnique({ where: { id: nflWeekId }, include: { season: true, officialTicket: true } }),
    prisma.user.findMany({ where: { active: true }, orderBy: { displayName: 'asc' } }),
    prisma.pick.findMany({
      where: { nflWeekId, state: { in: ['PENDING', 'LOCKED'] } },
      include: {
        market: true,
        nflGame: { include: { homeTeam: true, awayTeam: true } },
        officialLeg: true,
      },
    }),
    prisma.matchupReservation.findMany({ where: { nflWeekId } }),
  ]);
  if (!week) return null;

  const pickByUser = new Map(picks.map((p) => [p.userId, p]));
  const reservedUsers = new Set(reservations.map((r) => r.userId));
  const official = week.officialTicket?.status === 'CONFIRMED';

  const rows = members.map((member) => {
    const pick = pickByUser.get(member.id);
    const isSelf = member.id === viewerId;
    const locked = pick?.state === 'LOCKED';

    let status: string;
    if (locked && official) status = 'OFFICIAL';
    else if (locked && pick?.marketUnavailableAt) status = 'ACTION_REQUIRED';
    else if (locked) status = 'LOCKED';
    else if (pick?.state === 'PENDING') status = 'PENDING';
    else status = 'NO_PICK';

    // Visible to everyone once locked (the matchup is public), hidden while pending.
    const showDetail = locked || isSelf;

    return {
      userId: member.id,
      displayName: member.displayName,
      status,
      matchup: showDetail && pick ? `${pick.nflGame.awayTeam.nickname} @ ${pick.nflGame.homeTeam.nickname}` : null,
      selection: showDetail && pick ? pick.market.selectionLabel : null,
      subject: showDetail && pick ? pick.market.subjectLabel : null,
      lockedOdds: locked ? pick?.lockedAmericanOdds ?? null : null,
      currentOdds: showDetail && pick ? pick.market.americanOdds : null,
      marketUnavailable: locked ? Boolean(pick?.marketUnavailableAt) : false,
      result: pick?.officialLeg?.result ?? null,
      isSelf,
    };
  });

  return {
    week: {
      id: week.id,
      seasonYear: week.season.year,
      weekNumber: week.weekNumber,
      status: week.status as WeekStatus,
      frozen: Boolean(week.frozenAt),
      weekOffReason: week.weekOffReason,
    },
    lockedCount: reservedUsers.size,
    memberCount: members.length,
    rows,
  };
}

/** Declare or clear a Week Off (spec §78). */
export async function setWeekOff(nflWeekId: string, reason: string, actorId: string) {
  const week = await prisma.nFLWeek.update({
    where: { id: nflWeekId },
    data: { status: 'WEEK_OFF', weekOffReason: reason, weekOffSetAt: new Date() },
  });
  await audit({
    actorId,
    action: 'WEEK_OFF_DECLARED',
    entityType: 'NFLWeek',
    entityId: nflWeekId,
    summary: `Week ${week.weekNumber} declared a Week Off: ${reason}`,
  });
  return week;
}

export async function clearWeekOff(nflWeekId: string, actorId: string) {
  const week = await prisma.nFLWeek.update({
    where: { id: nflWeekId },
    data: { status: 'IN_PROGRESS', weekOffReason: null, weekOffSetAt: null },
  });
  await audit({
    actorId,
    action: 'WEEK_OFF_CLEARED',
    entityType: 'NFLWeek',
    entityId: nflWeekId,
    summary: `Week ${week.weekNumber} reopened for play`,
  });
  return week;
}

/**
 * Recompute the week's rollup status (spec §53). Never downgrades a week that
 * has already reached an official/settled state, and never touches a Week Off.
 */
export async function recomputeWeekStatus(nflWeekId: string): Promise<WeekStatus> {
  const week = await prisma.nFLWeek.findUniqueOrThrow({
    where: { id: nflWeekId },
    include: { officialTicket: true, parlay: true },
  });
  if (week.status === 'WEEK_OFF') return 'WEEK_OFF';

  if (week.parlay?.settled) return persist(nflWeekId, 'SETTLED');
  if (week.officialTicket?.status === 'CONFIRMED') {
    const anyLive = await prisma.nFLGame.count({ where: { nflWeekId, status: 'IN_PROGRESS' } });
    return persist(nflWeekId, anyLive > 0 ? 'LIVE' : 'OFFICIAL');
  }
  if (week.officialTicket) return persist(nflWeekId, 'TICKET_UPLOADED');

  const [memberCount, reservationCount, problems] = await Promise.all([
    prisma.user.count({ where: { active: true } }),
    prisma.matchupReservation.count({ where: { nflWeekId } }),
    prisma.pick.count({ where: { nflWeekId, state: 'LOCKED', marketUnavailableAt: { not: null } } }),
  ]);

  if (problems > 0) return persist(nflWeekId, 'ACTION_REQUIRED');
  if (reservationCount >= memberCount && memberCount > 0) return persist(nflWeekId, 'READY_TO_PLACE');
  return persist(nflWeekId, 'IN_PROGRESS');
}

async function persist(nflWeekId: string, status: WeekStatus): Promise<WeekStatus> {
  await prisma.nFLWeek.update({ where: { id: nflWeekId }, data: { status: status as never } });
  return status;
}
