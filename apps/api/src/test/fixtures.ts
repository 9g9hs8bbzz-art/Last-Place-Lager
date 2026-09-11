/**
 * Test-only fixtures. These build games and sportsbook markets that do not
 * exist, which is exactly why they live here and never in the seed script:
 * fabricated markets are permitted only in a development/test environment
 * (spec §95).
 */
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/auth.js';
import { selectionKeyOf } from '@fcp/shared';

let counter = 0;
const uid = () => `t${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function resetDatabase() {
  // Order matters: children before parents.
  await prisma.$transaction([
    prisma.resultAudit.deleteMany(),
    prisma.officialTicketLeg.deleteMany(),
    prisma.officialTicket.deleteMany(),
    prisma.pickChange.deleteMany(),
    prisma.matchupReservation.deleteMany(),
    prisma.pick.deleteMany(),
    prisma.watchedPick.deleteMany(),
    prisma.marketSnapshot.deleteMany(),
    prisma.market.deleteMany(),
    prisma.sportsbookEvent.deleteMany(),
    prisma.weather.deleteMany(),
    prisma.injury.deleteMany(),
    prisma.nFLGame.deleteMany(),
    prisma.parlay.deleteMany(),
    prisma.weeklyRecap.deleteMany(),
    prisma.readerError.deleteMany(),
    prisma.marketSnapshot.deleteMany(),
    prisma.readerRun.deleteMany(),
    prisma.nFLWeek.deleteMany(),
    prisma.season.deleteMany(),
    prisma.notification.deleteMany(),
    prisma.auditLog.deleteMany(),
    prisma.refreshToken.deleteMany(),
    prisma.historicalPick.deleteMany(),
    prisma.importConflict.deleteMany(),
    prisma.historicalImport.deleteMany(),
    prisma.user.deleteMany(),
  ]);
}

export async function makeUser(displayName: string, role: 'MEMBER' | 'ADMIN' = 'MEMBER') {
  return prisma.user.create({
    data: { displayName, legacyName: displayName, role, passwordHash: await hashPassword('test-password-1') },
  });
}

export async function makeWeek(opts: { year?: number; weekNumber?: number } = {}) {
  const year = opts.year ?? 2026;
  const season = await prisma.season.upsert({
    where: { year },
    create: { year, label: `${year} Season`, isCurrent: true },
    update: {},
  });
  return prisma.nFLWeek.create({
    data: { seasonId: season.id, weekNumber: opts.weekNumber ?? 1, status: 'IN_PROGRESS' },
  });
}

export async function makeGame(nflWeekId: string, away: string, home: string, opts: { eligible?: boolean; kickoffAt?: Date } = {}) {
  const [awayTeam, homeTeam] = await Promise.all([
    prisma.team.findUniqueOrThrow({ where: { abbreviation: away } }),
    prisma.team.findUniqueOrThrow({ where: { abbreviation: home } }),
  ]);
  return prisma.nFLGame.create({
    data: {
      nflWeekId,
      providerGameId: `${away}-${home}-${uid()}`,
      awayTeamId: awayTeam.id,
      homeTeamId: homeTeam.id,
      kickoffAt: opts.kickoffAt ?? new Date(Date.now() + 86_400_000),
      eligible: opts.eligible ?? true,
    },
  });
}

/** Create a sportsbook event + one priced selection attached to a game. */
export async function makeMarket(
  nflGameId: string,
  opts: {
    americanOdds?: number | null;
    line?: number | null;
    subjectLabel?: string;
    selectionLabel?: string;
    marketKey?: string;
    category?: string;
    available?: boolean;
  } = {},
) {
  const game = await prisma.nFLGame.findUniqueOrThrow({
    where: { id: nflGameId },
    include: { homeTeam: true, awayTeam: true },
  });
  const sourceEventId = `SBM-${game.providerGameId}`;
  // Several markets may be created for one game concurrently in tests, so this
  // tolerates losing the upsert race rather than failing the test setup.
  let event = await prisma.sportsbookEvent.findUnique({ where: { sourceEventId } });
  if (!event) {
    event = await prisma.sportsbookEvent
      .create({
        data: {
          sourceEventId,
          nflGameId,
          homeTeamName: game.homeTeam.nickname,
          awayTeamName: game.awayTeam.nickname,
          scheduledAt: game.kickoffAt,
          lastSuccessfulReadAt: new Date(),
        },
      })
      .catch(async () => prisma.sportsbookEvent.findUniqueOrThrow({ where: { sourceEventId } }));
  }

  const identity = {
    sourceEventId,
    category: (opts.category ?? 'PLAYER_PROP') as never,
    marketKey: opts.marketKey ?? 'RUSHING_YARDS',
    subjectKey: opts.subjectLabel ?? 'Josh Allen',
    selectionKey: opts.selectionLabel ?? 'OVER',
    line: opts.line ?? 25,
  };

  return prisma.market.create({
    data: {
      eventId: event.id,
      sourceMarketId: `M-${uid()}`,
      category: opts.category ?? 'PLAYER_PROP',
      marketKey: opts.marketKey ?? 'RUSHING_YARDS',
      marketLabel: 'Rushing Yards',
      subjectKey: opts.subjectLabel ?? 'Josh Allen',
      subjectLabel: opts.subjectLabel ?? 'Josh Allen',
      selectionKey: opts.selectionLabel ?? 'OVER',
      selectionLabel: `${opts.line ?? 25}+ ${opts.marketKey ?? 'Rushing Yards'}`,
      line: opts.line ?? 25,
      selectionIdentity: `${selectionKeyOf(identity)}|${uid()}`,
      americanOdds: opts.americanOdds === undefined ? -175 : opts.americanOdds,
      available: opts.available ?? true,
    },
  });
}
