import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { resetDatabase, makeUser, makeWeek, makeGame, makeMarket } from '../test/fixtures.js';
import { lockPick } from './picks.js';
import { detectLockedPickIssues, parlayReadiness } from './marketMonitor.js';

let week: Awaited<ReturnType<typeof makeWeek>>;
let austin: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  await resetDatabase();
  week = await makeWeek();
  austin = await makeUser('Austin', 'ADMIN');
});
afterAll(async () => { await prisma.$disconnect(); });

async function lockAt(odds: number) {
  const game = await makeGame(week.id, 'BUF', 'MIA');
  const market = await makeMarket(game.id, { americanOdds: odds });
  const { pick } = await lockPick({ userId: austin.id, nflWeekId: week.id, marketId: market.id });
  return { game, market, pick };
}

describe('ACCEPTANCE (spec §31, §97): -185 moves to -215', () => {
  it('warns the member and does NOT unlock, change or release anything', async () => {
    const { market, pick } = await lockAt(-185);
    await prisma.market.update({ where: { id: market.id }, data: { americanOdds: -215 } });

    const found = await detectLockedPickIssues(week.id);
    expect(found.movementAlerts).toBe(1);

    const alert = await prisma.notification.findFirstOrThrow({ where: { userId: austin.id } });
    expect(alert.kind).toBe('ODDS_GUIDELINE');
    expect(alert.body).toContain("outside the group's preferred odds range");

    // Nothing about the commitment changed.
    const after = await prisma.pick.findUniqueOrThrow({ where: { id: pick.id } });
    expect(after.state).toBe('LOCKED');
    expect(after.lockedAmericanOdds).toBe(-185);      // the locked snapshot stands
    expect(await prisma.matchupReservation.count({ where: { nflWeekId: week.id } })).toBe(1);
  });

  it('stays quiet about ordinary movement', async () => {
    const { market } = await lockAt(-150);
    await prisma.market.update({ where: { id: market.id }, data: { americanOdds: -155 } });
    const found = await detectLockedPickIssues(week.id);
    expect(found.movementAlerts).toBe(0);
    expect(await prisma.notification.count({ where: { userId: austin.id } })).toBe(0);
  });

  it('does not repeat the same alert on every hourly scan', async () => {
    const { market } = await lockAt(-185);
    await prisma.market.update({ where: { id: market.id }, data: { americanOdds: -215 } });
    await detectLockedPickIssues(week.id);
    await detectLockedPickIssues(week.id);
    await detectLockedPickIssues(week.id);
    expect(await prisma.notification.count({ where: { userId: austin.id } })).toBe(1);
  });
});

describe('ACCEPTANCE (spec §32, §97): the exact locked market disappears', () => {
  it('alerts ACTION REQUIRED and keeps the matchup reserved', async () => {
    const { market, pick, game } = await lockAt(-175);

    // The reader confirmed the selection is genuinely gone.
    await prisma.market.update({
      where: { id: market.id },
      data: { available: false, unavailableSince: new Date(), unavailableConfirmations: 2 },
    });

    const found = await detectLockedPickIssues(week.id);
    expect(found.unavailableAlerts).toBe(1);

    const alert = await prisma.notification.findFirstOrThrow({ where: { userId: austin.id, kind: 'MARKET_UNAVAILABLE' } });
    expect(alert.title).toBe('ACTION REQUIRED');
    expect(alert.body).toContain('no longer available at Sports Bet Montana');
    expect(alert.body).toContain('still reserved for you');

    // The reservation is untouched: the matchup remains his.
    const reservation = await prisma.matchupReservation.findFirstOrThrow({ where: { nflWeekId: week.id } });
    expect(reservation.userId).toBe(austin.id);
    expect(reservation.nflGameId).toBe(game.id);

    const after = await prisma.pick.findUniqueOrThrow({ where: { id: pick.id } });
    expect(after.state).toBe('LOCKED');
    expect(after.marketUnavailableAt).not.toBeNull();

    // And the week is flagged for the parlay manager.
    const refreshed = await prisma.nFLWeek.findUniqueOrThrow({ where: { id: week.id } });
    expect(refreshed.status).toBe('ACTION_REQUIRED');
  });

  it('never silently substitutes a different threshold', async () => {
    const game = await makeGame(week.id, 'BUF', 'MIA');
    const twentyFive = await makeMarket(game.id, { line: 25, americanOdds: -175 });
    const thirty = await makeMarket(game.id, { line: 30, americanOdds: -130 });
    const { pick } = await lockPick({ userId: austin.id, nflWeekId: week.id, marketId: twentyFive.id });

    await prisma.market.update({ where: { id: twentyFive.id }, data: { available: false, unavailableSince: new Date() } });
    await detectLockedPickIssues(week.id);

    const after = await prisma.pick.findUniqueOrThrow({ where: { id: pick.id } });
    expect(after.marketId).toBe(twentyFive.id);   // still pointing at 25+
    expect(after.marketId).not.toBe(thirty.id);
    expect(after.lockedLine!.toString()).toBe('25');
  });

  it('clears the alert when the selection returns to the board', async () => {
    const { market, pick } = await lockAt(-175);
    await prisma.market.update({ where: { id: market.id }, data: { available: false, unavailableSince: new Date() } });
    await detectLockedPickIssues(week.id);
    expect((await prisma.pick.findUniqueOrThrow({ where: { id: pick.id } })).marketUnavailableAt).not.toBeNull();

    await prisma.market.update({ where: { id: market.id }, data: { available: true, unavailableSince: null } });
    const found = await detectLockedPickIssues(week.id);
    expect(found.restored).toBe(1);
    expect((await prisma.pick.findUniqueOrThrow({ where: { id: pick.id } })).marketUnavailableAt).toBeNull();
  });
});

describe('admin parlay readiness (spec §53)', () => {
  it('reports each member as ready, outside-guideline or action-required', async () => {
    const tanner = await makeUser('Tanner');
    const carson = await makeUser('Carson');

    const g1 = await makeGame(week.id, 'BUF', 'MIA');
    const g2 = await makeGame(week.id, 'KC', 'DEN');
    const g3 = await makeGame(week.id, 'NYJ', 'NE');

    // Tanner: healthy.
    await lockPick({ userId: tanner.id, nflWeekId: week.id, marketId: (await makeMarket(g1.id, { americanOdds: -175 })).id });
    // Austin: drifted outside the guideline.
    const austinMarket = await makeMarket(g2.id, { americanOdds: -185 });
    await lockPick({ userId: austin.id, nflWeekId: week.id, marketId: austinMarket.id });
    await prisma.market.update({ where: { id: austinMarket.id }, data: { americanOdds: -215 } });
    // Carson: market gone.
    const carsonMarket = await makeMarket(g3.id, { americanOdds: -120 });
    await lockPick({ userId: carson.id, nflWeekId: week.id, marketId: carsonMarket.id });
    await prisma.market.update({ where: { id: carsonMarket.id }, data: { available: false, unavailableSince: new Date() } });
    await detectLockedPickIssues(week.id);

    const rows = await parlayReadiness(week.id);
    const byName = Object.fromEntries(rows.map((r) => [r.displayName, r]));

    expect(byName.Tanner.matchupReserved).toBe(true);
    expect(byName.Tanner.exactMarketAvailable).toBe(true);
    expect(byName.Tanner.withinOddsGuideline).toBe(true);
    expect(byName.Tanner.actionRequired).toBe(false);

    expect(byName.Austin.lockedOdds).toBe(-185);
    expect(byName.Austin.currentOdds).toBe(-215);
    expect(byName.Austin.withinOddsGuideline).toBe(false);

    expect(byName.Carson.exactMarketAvailable).toBe(false);
    expect(byName.Carson.actionRequired).toBe(true);
    expect(byName.Carson.notes).toContain('Exact market unavailable — ACTION REQUIRED');
  });

  it('flags a member with no pick at all', async () => {
    const rows = await parlayReadiness(week.id);
    expect(rows[0].matchupReserved).toBe(false);
    expect(rows[0].actionRequired).toBe(true);
    expect(rows[0].notes).toContain('No locked pick yet');
  });
});
