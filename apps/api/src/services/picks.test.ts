import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { resetDatabase, makeUser, makeWeek, makeGame, makeMarket } from '../test/fixtures.js';
import { lockPick, setPendingPick, unlockPick, removePendingPick, PickError } from './picks.js';
import { matchupStatesForWeek } from './weeks.js';

let week: Awaited<ReturnType<typeof makeWeek>>;
let austin: Awaited<ReturnType<typeof makeUser>>;
let tanner: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  await resetDatabase();
  week = await makeWeek();
  austin = await makeUser('Austin', 'ADMIN');
  tanner = await makeUser('Tanner');
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('ACCEPTANCE (spec §7, §8, §97): matchup reservation', () => {
  it('lets exactly one of two simultaneous locks on the same game succeed', async () => {
    const game = await makeGame(week.id, 'BUF', 'MIA');
    // Two DIFFERENT wagers from the SAME matchup: a Josh Allen prop and the spread.
    const allenProp = await makeMarket(game.id, { subjectLabel: 'Josh Allen', line: 25 });
    const spread = await makeMarket(game.id, {
      category: 'GAME_LINE', marketKey: 'SPREAD', subjectLabel: 'Bills', line: -3.5, americanOdds: -110,
    });

    // Fire both locks concurrently — the whole point of the test.
    const results = await Promise.allSettled([
      lockPick({ userId: austin.id, nflWeekId: week.id, marketId: allenProp.id }),
      lockPick({ userId: tanner.id, nflWeekId: week.id, marketId: spread.id }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const error = (rejected[0] as PromiseRejectedResult).reason as PickError;
    expect(error).toBeInstanceOf(PickError);
    expect(error.code).toBe('MATCHUP_TAKEN');
    expect(error.message).toBe('This matchup was just reserved by another member. Please choose another game.');

    // The database holds exactly one reservation for that game.
    const reservations = await prisma.matchupReservation.findMany({ where: { nflWeekId: week.id, nflGameId: game.id } });
    expect(reservations).toHaveLength(1);
  });

  it('reserves the ENTIRE matchup regardless of which market was chosen', async () => {
    const game = await makeGame(week.id, 'BUF', 'MIA');
    const allenProp = await makeMarket(game.id, { subjectLabel: 'Josh Allen' });
    const cookProp = await makeMarket(game.id, { subjectLabel: 'James Cook', marketKey: 'RUSHING_YARDS', line: 45 });

    await lockPick({ userId: tanner.id, nflWeekId: week.id, marketId: allenProp.id });

    // Austin wants a completely different player from the same game: still blocked.
    await expect(
      lockPick({ userId: austin.id, nflWeekId: week.id, marketId: cookProp.id }),
    ).rejects.toMatchObject({ code: 'MATCHUP_TAKEN' });
  });

  it('survives ten members racing for the same matchup at once', async () => {
    const game = await makeGame(week.id, 'KC', 'DEN');
    const users = await Promise.all(
      ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'].map((n) => makeUser(`Racer${n}`)),
    );
    const markets = await Promise.all(users.map(() => makeMarket(game.id)));

    const results = await Promise.allSettled(
      users.map((u, i) => lockPick({ userId: u.id, nflWeekId: week.id, marketId: markets[i].id })),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.matchupReservation.count({ where: { nflGameId: game.id } })).toBe(1);
  });

  it('names the member who took the matchup so the message is actionable', async () => {
    const game = await makeGame(week.id, 'BUF', 'MIA');
    const m1 = await makeMarket(game.id);
    const m2 = await makeMarket(game.id, { subjectLabel: 'James Cook' });
    await lockPick({ userId: tanner.id, nflWeekId: week.id, marketId: m1.id });
    try {
      await lockPick({ userId: austin.id, nflWeekId: week.id, marketId: m2.id });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as PickError).detail).toEqual({ reservedBy: 'Tanner' });
    }
  });
});

describe('ACCEPTANCE (spec §10, §97): a pending pick does NOT reserve the matchup', () => {
  it('creates no reservation row and leaves the game lockable by someone else', async () => {
    const game = await makeGame(week.id, 'BUF', 'MIA');
    const market = await makeMarket(game.id);
    const other = await makeMarket(game.id, { subjectLabel: 'James Cook' });

    await setPendingPick(austin.id, week.id, market.id);

    expect(await prisma.matchupReservation.count({ where: { nflWeekId: week.id } })).toBe(0);

    // Tanner can still lock that very game.
    const locked = await lockPick({ userId: tanner.id, nflWeekId: week.id, marketId: other.id });
    expect(locked.pick.state).toBe('LOCKED');
    expect(await prisma.matchupReservation.count({ where: { nflWeekId: week.id } })).toBe(1);
  });

  it('keeps a pending pick private from other members but visible to its owner', async () => {
    const game = await makeGame(week.id, 'BUF', 'MIA');
    const market = await makeMarket(game.id);
    await setPendingPick(austin.id, week.id, market.id);

    const asAustin = await matchupStatesForWeek(week.id, austin.id);
    const asTanner = await matchupStatesForWeek(week.id, tanner.id);

    expect(asAustin.find((g) => g.id === game.id)!.state).toBe('MY_PENDING_GAME');
    // To everyone else the game simply looks free — no hint of Austin's interest.
    expect(asTanner.find((g) => g.id === game.id)!.state).toBe('AVAILABLE');
  });

  it('alerts the pending holder when someone else takes the matchup', async () => {
    const game = await makeGame(week.id, 'BUF', 'MIA');
    const mine = await makeMarket(game.id);
    const theirs = await makeMarket(game.id, { subjectLabel: 'James Cook' });

    await setPendingPick(austin.id, week.id, mine.id);
    await lockPick({ userId: tanner.id, nflWeekId: week.id, marketId: theirs.id });

    const alerts = await prisma.notification.findMany({ where: { userId: austin.id } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('MATCHUP_TAKEN');
    expect(alerts[0].body).toContain('Tanner');
  });

  it('can be removed without touching any reservation', async () => {
    const game = await makeGame(week.id, 'BUF', 'MIA');
    const market = await makeMarket(game.id);
    await setPendingPick(austin.id, week.id, market.id);
    await removePendingPick(austin.id, week.id);
    const active = await prisma.pick.findFirst({ where: { userId: austin.id, state: { in: ['PENDING', 'LOCKED'] } } });
    expect(active).toBeNull();
  });
});

describe('ACCEPTANCE (spec §13, §97): unlock releases the game immediately', () => {
  it('frees the matchup for another member on the very next request', async () => {
    const game = await makeGame(week.id, 'BUF', 'MIA');
    const first = await makeMarket(game.id);
    const second = await makeMarket(game.id, { subjectLabel: 'James Cook' });

    await lockPick({ userId: tanner.id, nflWeekId: week.id, marketId: first.id });
    await expect(
      lockPick({ userId: austin.id, nflWeekId: week.id, marketId: second.id }),
    ).rejects.toMatchObject({ code: 'MATCHUP_TAKEN' });

    await unlockPick(tanner.id, week.id);

    const now = await lockPick({ userId: austin.id, nflWeekId: week.id, marketId: second.id });
    expect(now.pick.state).toBe('LOCKED');
  });

  it('preserves the pick change history through lock and unlock', async () => {
    const game = await makeGame(week.id, 'BUF', 'MIA');
    const market = await makeMarket(game.id);
    const { pick } = await lockPick({ userId: tanner.id, nflWeekId: week.id, marketId: market.id });
    await unlockPick(tanner.id, week.id);

    const changes = await prisma.pickChange.findMany({ where: { pickId: pick.id }, orderBy: { changedAt: 'asc' } });
    expect(changes.map((c) => c.changeKind)).toEqual(['LOCKED', 'UNLOCKED']);
  });
});

describe('ACCEPTANCE (spec §30, §97): outside-guideline picks warn but are allowed', () => {
  it('locks a +225 selection and reports the warning', async () => {
    const game = await makeGame(week.id, 'BUF', 'MIA');
    const market = await makeMarket(game.id, { americanOdds: 225 });

    const result = await lockPick({ userId: austin.id, nflWeekId: week.id, marketId: market.id });

    expect(result.pick.state).toBe('LOCKED');
    expect(result.outsideGuideline).toBe(true);
    expect(result.guidelineMessage).toContain('OUTSIDE GROUP ODDS GUIDELINE');
    expect(result.pick.outsideGuidelineAtLock).toBe(true);
  });

  it('records an inside-range pick as compliant', async () => {
    const game = await makeGame(week.id, 'BUF', 'MIA');
    const market = await makeMarket(game.id, { americanOdds: -175 });
    const result = await lockPick({ userId: austin.id, nflWeekId: week.id, marketId: market.id });
    expect(result.outsideGuideline).toBe(false);
    expect(result.guidelineMessage).toBeNull();
  });
});

describe('locked snapshot integrity (spec §12, §86)', () => {
  it('keeps the locked price even after the sportsbook moves', async () => {
    const game = await makeGame(week.id, 'BUF', 'MIA');
    const market = await makeMarket(game.id, { americanOdds: -175 });
    const { pick } = await lockPick({ userId: austin.id, nflWeekId: week.id, marketId: market.id });
    expect(pick.lockedAmericanOdds).toBe(-175);

    // The board moves.
    await prisma.market.update({ where: { id: market.id }, data: { americanOdds: -205 } });

    const after = await prisma.pick.findUniqueOrThrow({ where: { id: pick.id }, include: { market: true } });
    expect(after.lockedAmericanOdds).toBe(-175); // unchanged
    expect(after.market.americanOdds).toBe(-205); // current board, tracked separately
  });
});

describe('eligibility and week rules', () => {
  it('refuses a game the administrator marked not eligible (spec §6)', async () => {
    const game = await makeGame(week.id, 'BUF', 'MIA', { eligible: false });
    const market = await makeMarket(game.id);
    await expect(lockPick({ userId: austin.id, nflWeekId: week.id, marketId: market.id }))
      .rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
  });

  it('refuses a game that already kicked off', async () => {
    const game = await makeGame(week.id, 'BUF', 'MIA', { kickoffAt: new Date(Date.now() - 3_600_000) });
    const market = await makeMarket(game.id);
    await expect(lockPick({ userId: austin.id, nflWeekId: week.id, marketId: market.id }))
      .rejects.toMatchObject({ code: 'GAME_STARTED' });
  });

  it('refuses any pick during a declared Week Off (spec §78)', async () => {
    const game = await makeGame(week.id, 'BUF', 'MIA');
    const market = await makeMarket(game.id);
    await prisma.nFLWeek.update({ where: { id: week.id }, data: { status: 'WEEK_OFF' } });
    await expect(lockPick({ userId: austin.id, nflWeekId: week.id, marketId: market.id }))
      .rejects.toMatchObject({ code: 'WEEK_OFF' });
  });

  it('holds each member to one matchup per week', async () => {
    const g1 = await makeGame(week.id, 'BUF', 'MIA');
    const g2 = await makeGame(week.id, 'KC', 'DEN');
    const m1 = await makeMarket(g1.id);
    const m2 = await makeMarket(g2.id);
    await lockPick({ userId: austin.id, nflWeekId: week.id, marketId: m1.id });
    await expect(lockPick({ userId: austin.id, nflWeekId: week.id, marketId: m2.id }))
      .rejects.toMatchObject({ code: 'ALREADY_LOCKED' });
  });
});
