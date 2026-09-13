import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { resetDatabase, makeUser, makeWeek, makeGame, makeMarket } from '../test/fixtures.js';
import { syncWeekSchedule, ensureWeekAndSync, currentNflWeek } from './scheduleSync.js';
import { lockPick } from './picks.js';
import { schedulerStatus, runReaderJob, runLiveJob, runPicksJob, runNextWeekJob } from './scheduler.js';
import { dataUnavailable } from '@fcp/shared';
import type { ScheduleGame, ScheduleProvider } from '../providers/types.js';

/** A schedule provider whose answer the test controls. */
function fakeSchedule(games: ScheduleGame[] | null, reason = 'ESPN unreachable'): ScheduleProvider {
  return {
    name: 'FAKE_SCHEDULE',
    isConfigured: () => true,
    async getWeekSchedule() {
      if (games === null) return dataUnavailable('FAKE_SCHEDULE', reason);
      return { status: 'OK', data: games, fetchedAt: new Date(), provider: 'FAKE_SCHEDULE' };
    },
  };
}

/**
 * Real 2026 week 1 kickoff times, as ESPN reports them, in UTC. The weekday a
 * game belongs to is the weekday in Montana, which for a night game is the day
 * before the one UTC reports — see packages/shared/src/time.ts.
 */
/** Sunday 11:00 AM Mountain. */
const SUNDAY = new Date('2026-09-13T17:00:00Z');
/** Sunday Night Football: 6:20 PM Mountain on Sunday, already Monday in UTC. */
const SUNDAY_NIGHT = new Date('2026-09-14T00:20:00Z');
/** Monday Night Football: 6:15 PM Mountain on Monday, already Tuesday in UTC. */
const MONDAY_NIGHT = new Date('2026-09-15T00:15:00Z');
/** Thursday 6:20 PM Mountain, already Friday in UTC. Never eligible. */
const THURSDAY = new Date('2026-09-11T00:20:00Z');

const game = (id: string, away: string, home: string, kickoffAt: Date, over: Partial<ScheduleGame> = {}): ScheduleGame => ({
  providerGameId: id,
  awayTeamAbbrev: away,
  homeTeamAbbrev: home,
  kickoffAt,
  venue: 'Some Stadium',
  indoor: false,
  ...over,
});

beforeEach(async () => {
  await resetDatabase();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('pulling a week\'s games', () => {
  it('creates the games and marks Sunday and Monday eligible', async () => {
    const week = await makeWeek();
    const result = await syncWeekSchedule(
      week.id,
      fakeSchedule([
        game('e1', 'BUF', 'MIA', SUNDAY),
        game('e2', 'KC', 'DEN', MONDAY_NIGHT),
        game('e3', 'TB', 'NO', THURSDAY),
      ]),
    );

    expect(result.available).toBe(true);
    expect(result.created).toBe(3);
    expect(result.eligible).toBe(2);
    expect(result.notEligible).toBe(1);

    const thursday = await prisma.nFLGame.findFirstOrThrow({ where: { providerGameId: 'e3' } });
    expect(thursday.eligible).toBe(false);
    expect(thursday.eligibilityNote).toContain('NOT ELIGIBLE');
  });

  it('keeps Monday Night Football on the board (spec §6)', async () => {
    // The kickoff is Tuesday in UTC. Reading the weekday from UTC removed one
    // pickable matchup from every single week, which with one matchup per member
    // is a real loss rather than a cosmetic one.
    const week = await makeWeek();
    const result = await syncWeekSchedule(week.id, fakeSchedule([game('mnf', 'DEN', 'KC', MONDAY_NIGHT)]));

    expect(result.eligible).toBe(1);
    expect(result.notEligible).toBe(0);
    const mnf = await prisma.nFLGame.findFirstOrThrow({ where: { providerGameId: 'mnf' } });
    expect(mnf.eligible).toBe(true);
    expect(mnf.eligibilityNote).toBeNull();
  });

  it('keeps Sunday Night Football eligible, and for the right reason', async () => {
    const week = await makeWeek();
    const result = await syncWeekSchedule(week.id, fakeSchedule([game('snf', 'DAL', 'NYG', SUNDAY_NIGHT)]));
    expect(result.eligible).toBe(1);
    const snf = await prisma.nFLGame.findFirstOrThrow({ where: { providerGameId: 'snf' } });
    expect(snf.eligible).toBe(true);
  });

  it('still refuses a Thursday night game', async () => {
    const week = await makeWeek();
    const result = await syncWeekSchedule(week.id, fakeSchedule([game('tnf', 'SF', 'LAR', THURSDAY)]));
    expect(result.eligible).toBe(0);
    expect(result.notEligible).toBe(1);
  });

  it('is safe to run twice — it updates rather than duplicating', async () => {
    const week = await makeWeek();
    const provider = fakeSchedule([game('e1', 'BUF', 'MIA', SUNDAY)]);
    await syncWeekSchedule(week.id, provider);

    // The NFL moves the kickoff by an hour.
    const moved = new Date(SUNDAY.getTime() + 3_600_000);
    const second = await syncWeekSchedule(week.id, fakeSchedule([game('e1', 'BUF', 'MIA', moved)]));

    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
    expect(await prisma.nFLGame.count({ where: { nflWeekId: week.id } })).toBe(1);
    const row = await prisma.nFLGame.findFirstOrThrow({ where: { providerGameId: 'e1' } });
    expect(row.kickoffAt.toISOString()).toBe(moved.toISOString());
  });

  it('does not overturn an administrator\'s own eligibility decision', async () => {
    const week = await makeWeek();
    await syncWeekSchedule(week.id, fakeSchedule([game('e1', 'TB', 'NO', THURSDAY)]));

    // The admin opens the Thursday game for this unusual week.
    const before = await prisma.nFLGame.findFirstOrThrow({ where: { providerGameId: 'e1' } });
    await prisma.nFLGame.update({
      where: { id: before.id },
      data: { eligible: true, eligibilityNote: 'Holiday week — opened by the parlay manager' },
    });

    await syncWeekSchedule(week.id, fakeSchedule([game('e1', 'TB', 'NO', THURSDAY)]));

    const after = await prisma.nFLGame.findFirstOrThrow({ where: { providerGameId: 'e1' } });
    expect(after.eligible).toBe(true);
    expect(after.eligibilityNote).toContain('Holiday week');
  });

  it('reports an unrecognised team rather than dropping the game silently', async () => {
    const week = await makeWeek();
    const result = await syncWeekSchedule(week.id, fakeSchedule([game('e1', 'XYZ', 'MIA', SUNDAY)]));
    expect(result.created).toBe(0);
    expect(result.skippedUnknownTeam).toEqual(['XYZ @ MIA']);
  });

  it('accepts the abbreviations ESPN uses via team aliases', async () => {
    const week = await makeWeek();
    // WSH and JAC are ESPN's spellings; the provider normalizes them, and the
    // Team aliases catch them even if it did not.
    const result = await syncWeekSchedule(week.id, fakeSchedule([game('e1', 'WSH', 'JAC', SUNDAY)]));
    expect(result.created).toBe(1);
  });

  it('says so plainly when the schedule cannot be retrieved', async () => {
    const week = await makeWeek();
    const result = await syncWeekSchedule(week.id, fakeSchedule(null, 'ESPN returned nothing readable'));
    expect(result.available).toBe(false);
    expect(result.reason).toContain('ESPN returned nothing readable');
    expect(await prisma.nFLGame.count()).toBe(0);
  });

  it('creates the season and week when they do not exist yet', async () => {
    const result = await ensureWeekAndSync(2027, 5, fakeSchedule([game('e1', 'BUF', 'MIA', SUNDAY)]));
    expect(result.available).toBe(true);
    expect(result.nflWeekId).toBeTruthy();
    const season = await prisma.season.findUniqueOrThrow({ where: { year: 2027 } });
    const week = await prisma.nFLWeek.findFirstOrThrow({ where: { seasonId: season.id, weekNumber: 5 } });
    expect(await prisma.nFLGame.count({ where: { nflWeekId: week.id } })).toBe(1);
  });
});

describe('working out the current NFL week', () => {
  it('is week 1 in the days after the season opens', () => {
    // Labor Day 2026 is 7 September, so week 1 runs from the 8th.
    expect(currentNflWeek(new Date('2026-09-10T12:00:00Z'))).toEqual({ seasonYear: 2026, weekNumber: 1 });
  });

  it('advances a week at a time', () => {
    expect(currentNflWeek(new Date('2026-09-16T12:00:00Z')).weekNumber).toBe(2);
  });

  it('still reports week 1 before the season starts', () => {
    expect(currentNflWeek(new Date('2026-08-01T12:00:00Z'))).toEqual({ seasonYear: 2026, weekNumber: 1 });
  });

  it('treats January as belonging to the previous season', () => {
    expect(currentNflWeek(new Date('2027-01-05T12:00:00Z')).seasonYear).toBe(2026);
  });

  it('never runs past the end of the post-season', () => {
    expect(currentNflWeek(new Date('2027-02-20T12:00:00Z')).weekNumber).toBeLessThanOrEqual(22);
  });
});

describe('the background scheduler', () => {
  it('is switched off during tests so jobs never fire on their own', () => {
    const status = schedulerStatus();
    expect(status.started).toBe(false);
    expect(status.jobs.map((j) => j.job).sort()).toEqual(['live', 'nextWeek', 'picks', 'reader']);
  });

  it('runs the board reader no more than once an hour', () => {
    const reader = schedulerStatus().jobs.find((j) => j.job === 'reader')!;
    expect(reader.everyMinutes).toBe(60);
  });

  it('does nothing when there is no active week', async () => {
    // None of these should throw with an empty database.
    await expect(runReaderJob()).resolves.toBeUndefined();
    await expect(runLiveJob()).resolves.toBeUndefined();
    await expect(runPicksJob()).resolves.toBeUndefined();
    await expect(runNextWeekJob()).resolves.toBeUndefined();
  });

  it('leaves a frozen week alone', async () => {
    const week = await makeWeek();
    const user = await makeUser('Tanner');
    const g = await makeGame(week.id, 'BUF', 'MIA');
    const market = await makeMarket(g.id, { americanOdds: -185 });
    await lockPick({ userId: user.id, nflWeekId: week.id, marketId: market.id });

    await prisma.nFLWeek.update({ where: { id: week.id }, data: { frozenAt: new Date(), status: 'OFFICIAL' } });
    await prisma.market.update({ where: { id: market.id }, data: { americanOdds: -260 } });

    // The price moved far enough to alert, but the week is frozen so the job
    // must not raise anything.
    await runPicksJob();
    expect(await prisma.notification.count({ where: { kind: 'ODDS_GUIDELINE' } })).toBe(0);
  });

  it('raises movement alerts for an open week', async () => {
    const week = await makeWeek();
    const user = await makeUser('Tanner');
    const g = await makeGame(week.id, 'BUF', 'MIA');
    const market = await makeMarket(g.id, { americanOdds: -185 });
    await lockPick({ userId: user.id, nflWeekId: week.id, marketId: market.id });
    await prisma.market.update({ where: { id: market.id }, data: { americanOdds: -215 } });

    await runPicksJob();
    expect(await prisma.notification.count({ where: { userId: user.id } })).toBeGreaterThan(0);
  });
});
