/**
 * Pulling an NFL week's games from the schedule provider (spec §88).
 *
 * This is the step that turns an empty week into something members can pick
 * from. It is deliberately idempotent: running it again after the NFL moves a
 * kickoff updates the existing rows rather than creating duplicates, and it
 * never deletes a game that already carries a reservation.
 */
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { isDataUnavailable, weekdayIn } from '@fcp/shared';
import { env } from '../lib/env.js';
import type { ScheduleProvider } from '../providers/types.js';
import { linkEventsToGames } from './readerRun.js';

export interface SyncResult {
  available: boolean;
  reason?: string;
  created: number;
  updated: number;
  skippedUnknownTeam: string[];
  eligible: number;
  notEligible: number;
}

/**
 * Fetch the slate for one week and write it in.
 *
 * Eligibility follows the week's own configured days — Sunday and Monday by
 * default (spec §6). Anything outside them is still recorded so it can be
 * researched, but is marked not eligible and cannot be selected.
 */
export async function syncWeekSchedule(
  nflWeekId: string,
  provider: ScheduleProvider,
  actorId?: string,
): Promise<SyncResult> {
  const week = await prisma.nFLWeek.findUniqueOrThrow({
    where: { id: nflWeekId },
    include: { season: true },
  });

  const result = await provider.getWeekSchedule(week.season.year, week.weekNumber);
  if (isDataUnavailable(result)) {
    return { available: false, reason: result.reason, created: 0, updated: 0, skippedUnknownTeam: [], eligible: 0, notEligible: 0 };
  }

  const teams = await prisma.team.findMany();
  const byAbbrev = new Map(teams.map((t) => [t.abbreviation.toUpperCase(), t]));
  for (const t of teams) {
    for (const alias of t.aliases) byAbbrev.set(alias.toUpperCase(), t);
  }

  const eligibleDays = week.eligibleWeekdays;
  let created = 0;
  let updated = 0;
  let eligible = 0;
  let notEligible = 0;
  const skippedUnknownTeam: string[] = [];

  for (const game of result.data) {
    const home = byAbbrev.get(game.homeTeamAbbrev.toUpperCase());
    const away = byAbbrev.get(game.awayTeamAbbrev.toUpperCase());
    if (!home || !away) {
      // A team we do not recognise is reported, never quietly dropped: it
      // usually means a relocation or rebrand that the roster needs.
      skippedUnknownTeam.push(`${game.awayTeamAbbrev} @ ${game.homeTeamAbbrev}`);
      continue;
    }

    const isEligible = eligibleDays.includes(weekdayIn(game.kickoffAt, env.groupTimeZone));
    if (isEligible) eligible += 1;
    else notEligible += 1;

    const existing = await prisma.nFLGame.findUnique({
      where: { nflWeekId_providerGameId: { nflWeekId, providerGameId: game.providerGameId } },
    });

    if (existing) {
      await prisma.nFLGame.update({
        where: { id: existing.id },
        data: {
          kickoffAt: game.kickoffAt,
          venue: game.venue,
          indoor: game.indoor,
          // An administrator's manual eligibility decision is respected: only
          // games still on their automatic setting get recalculated.
          ...(existing.eligibilityNote === null || existing.eligibilityNote === AUTO_NOTE
            ? { eligible: isEligible, eligibilityNote: isEligible ? null : AUTO_NOTE }
            : {}),
        },
      });
      updated += 1;
    } else {
      await prisma.nFLGame.create({
        data: {
          nflWeekId,
          providerGameId: game.providerGameId,
          homeTeamId: home.id,
          awayTeamId: away.id,
          kickoffAt: game.kickoffAt,
          venue: game.venue,
          indoor: game.indoor,
          eligible: isEligible,
          eligibilityNote: isEligible ? null : AUTO_NOTE,
        },
      });
      created += 1;
    }
  }

  // Any sportsbook events already read can now be matched to these games.
  await linkEventsToGames(nflWeekId);

  await audit({
    actorId: actorId ?? null,
    action: 'SCHEDULE_SYNCED',
    entityType: 'NFLWeek',
    entityId: nflWeekId,
    summary: `Pulled ${week.season.year} week ${week.weekNumber}: ${created} new, ${updated} updated, ${eligible} eligible`,
    detail: { provider: result.provider, skippedUnknownTeam },
  });

  return { available: true, created, updated, skippedUnknownTeam, eligible, notEligible };
}

const AUTO_NOTE = "NOT ELIGIBLE FOR THIS WEEK'S PARLAY";

/**
 * Make sure the season and week rows exist, then pull the slate.
 * This is what the Admin "set up this week" button calls.
 */
export async function ensureWeekAndSync(
  seasonYear: number,
  weekNumber: number,
  provider: ScheduleProvider,
  actorId?: string,
): Promise<SyncResult & { nflWeekId: string }> {
  const season = await prisma.season.upsert({
    where: { year: seasonYear },
    create: { year: seasonYear, label: `${seasonYear} Season`, isCurrent: true },
    update: {},
  });

  const week = await prisma.nFLWeek.upsert({
    where: { seasonId_weekNumber: { seasonId: season.id, weekNumber } },
    create: { seasonId: season.id, weekNumber },
    update: {},
  });

  const result = await syncWeekSchedule(week.id, provider, actorId);
  return { ...result, nflWeekId: week.id };
}

/**
 * Work out which NFL week it is now, so the scheduler and the setup screen can
 * offer a sensible default. The NFL regular season opens on the Thursday after
 * Labor Day; week 1 is the seven days from that Tuesday.
 */
export function currentNflWeek(now: Date = new Date()): { seasonYear: number; weekNumber: number } {
  const year = now.getUTCFullYear();
  // A season that has not started yet still belongs to the previous year's
  // numbering until early September.
  const seasonYear = now.getUTCMonth() < 2 ? year - 1 : year;
  const opener = seasonOpener(seasonYear);

  const daysSince = Math.floor((now.getTime() - opener.getTime()) / 86_400_000);
  if (daysSince < 0) return { seasonYear, weekNumber: 1 };

  const weekNumber = Math.min(22, Math.floor(daysSince / 7) + 1);
  return { seasonYear, weekNumber };
}

/** The Tuesday before the season's opening Thursday, in UTC. */
function seasonOpener(seasonYear: number): Date {
  // Labor Day is the first Monday in September.
  const sept = new Date(Date.UTC(seasonYear, 8, 1));
  const daysToMonday = (8 - sept.getUTCDay()) % 7;
  const laborDay = new Date(Date.UTC(seasonYear, 8, 1 + daysToMonday));
  // Week 1 runs from the following day.
  return new Date(laborDay.getTime() + 86_400_000);
}
