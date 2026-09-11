import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { resetDatabase, makeUser, makeWeek, makeGame, makeMarket } from '../test/fixtures.js';
import { lockPick, setPendingPick, PickError } from './picks.js';
import { uploadTicket, verifyTicket, confirmOfficialParlay, resolveLeg, TicketError } from './tickets.js';
import { gradeOfficialLeg, manuallyGradeLeg, sweatBoard, settleParlayIfComplete } from './live.js';

let week: Awaited<ReturnType<typeof makeWeek>>;
let tanner: Awaited<ReturnType<typeof makeUser>>;
let admin: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  await resetDatabase();
  week = await makeWeek();
  admin = await makeUser('Austin', 'ADMIN');
  tanner = await makeUser('Tanner');
});
afterAll(async () => { await prisma.$disconnect(); });

/** Lock a Josh Allen 25+ rushing prop at -175 for Tanner. */
async function lockAllen(odds = -175, line = 25) {
  const game = await makeGame(week.id, 'BUF', 'MIA');
  const market = await makeMarket(game.id, { americanOdds: odds, line, subjectLabel: 'Josh Allen' });
  const { pick } = await lockPick({ userId: tanner.id, nflWeekId: week.id, marketId: market.id });
  return { game, market, pick };
}

async function newTicket() {
  return uploadTicket({ nflWeekId: week.id, imagePath: '/tmp/ticket.jpg', mimeType: 'image/jpeg', uploadedById: admin.id });
}

async function addLeg(ticketId: string, over: Partial<{ legIndex: number; descriptionText: string; subjectLabel: string; selectionLabel: string; line: number; americanOdds: number; marketKey: string }> = {}) {
  return prisma.officialTicketLeg.create({
    data: {
      ticketId,
      legIndex: over.legIndex ?? 0,
      descriptionText: over.descriptionText ?? 'Josh Allen 25+ Rushing Yards',
      subjectLabel: over.subjectLabel ?? 'Josh Allen',
      selectionLabel: over.selectionLabel ?? '25+ Rushing Yards',
      marketKey: over.marketKey ?? 'RUSHING_YARDS',
      line: over.line ?? 25,
      americanOdds: over.americanOdds ?? -175,
    },
  });
}

describe('ACCEPTANCE (spec §56, §97): ticket odds differ from locked odds', () => {
  it('accepts the same selection at the ticket price of -205', async () => {
    await lockAllen(-175, 25);
    const ticket = await newTicket();
    await addLeg(ticket.id, { americanOdds: -205 });

    const result = await verifyTicket(ticket.id);

    expect(result.status).toBe('VERIFIED');
    expect(result.results[0].outcome).toBe('MATCH_ODDS_CHANGED');
    expect(result.results[0].note).toContain('Locked -175');
    expect(result.results[0].note).toContain('ticket -205');

    // Both prices survive independently (spec §58).
    const leg = await prisma.officialTicketLeg.findFirstOrThrow({ where: { ticketId: ticket.id }, include: { pick: true } });
    expect(leg.americanOdds).toBe(-205);          // official
    expect(leg.pick!.lockedAmericanOdds).toBe(-175); // originally locked
    expect(leg.userId).toBe(tanner.id);
  });
});

describe('ACCEPTANCE (spec §56, §97): threshold mismatch requires admin review', () => {
  it('flags 60+ locked against 70+ on the ticket and refuses to confirm', async () => {
    const game = await makeGame(week.id, 'MIN', 'GB');
    const market = await makeMarket(game.id, { line: 60, subjectLabel: 'Justin Jefferson', americanOdds: -120 });
    await lockPick({ userId: tanner.id, nflWeekId: week.id, marketId: market.id });

    const ticket = await newTicket();
    await addLeg(ticket.id, { subjectLabel: 'Justin Jefferson', line: 70, selectionLabel: '70+ Receiving Yards', descriptionText: 'Justin Jefferson 70+ Receiving Yards' });

    const result = await verifyTicket(ticket.id);

    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.results[0].outcome).toBe('SELECTION_MISMATCH');
    expect(result.results[0].note).toContain('Admin review required');

    // Confirmation is blocked until a person decides.
    await expect(confirmOfficialParlay(ticket.id, admin.id)).rejects.toMatchObject({ code: 'UNRESOLVED_LEGS' });
  });

  it('never silently rewrites the member record', async () => {
    const game = await makeGame(week.id, 'MIN', 'GB');
    const market = await makeMarket(game.id, { line: 60, subjectLabel: 'Justin Jefferson' });
    const { pick } = await lockPick({ userId: tanner.id, nflWeekId: week.id, marketId: market.id });
    const ticket = await newTicket();
    await addLeg(ticket.id, { subjectLabel: 'Justin Jefferson', line: 70 });
    await verifyTicket(ticket.id);

    const after = await prisma.pick.findUniqueOrThrow({ where: { id: pick.id } });
    expect(after.lockedLine!.toString()).toBe('60');   // untouched
  });

  it('lets an administrator resolve the leg and then confirm', async () => {
    const game = await makeGame(week.id, 'MIN', 'GB');
    const market = await makeMarket(game.id, { line: 60, subjectLabel: 'Justin Jefferson' });
    const { pick } = await lockPick({ userId: tanner.id, nflWeekId: week.id, marketId: market.id });
    const ticket = await newTicket();
    const leg = await addLeg(ticket.id, { subjectLabel: 'Justin Jefferson', line: 70 });
    await verifyTicket(ticket.id);

    await resolveLeg({ legId: leg.id, actorId: admin.id, userId: tanner.id, pickId: pick.id, note: 'Confirmed with Tanner: the 70+ on the ticket is what was placed.' });
    const confirmed = await confirmOfficialParlay(ticket.id, admin.id);
    expect(confirmed.status).toBe('CONFIRMED');

    const audits = await prisma.auditLog.findMany({ where: { action: 'TICKET_LEG_RESOLVED' } });
    expect(audits).toHaveLength(1);
  });
});

describe('ACCEPTANCE (spec §57, §97): confirming the parlay freezes member editing', () => {
  it('stops members changing or unlocking picks afterwards', async () => {
    const { pick } = await lockAllen();
    const ticket = await newTicket();
    await addLeg(ticket.id);
    await verifyTicket(ticket.id);
    await confirmOfficialParlay(ticket.id, admin.id);

    const frozen = await prisma.nFLWeek.findUniqueOrThrow({ where: { id: week.id } });
    expect(frozen.frozenAt).not.toBeNull();
    expect(frozen.status).toBe('OFFICIAL');

    const another = await makeGame(week.id, 'KC', 'DEN');
    const otherMarket = await makeMarket(another.id);

    await expect(lockPick({ userId: tanner.id, nflWeekId: week.id, marketId: otherMarket.id }))
      .rejects.toMatchObject({ code: 'WEEK_FROZEN' });
    await expect(setPendingPick(tanner.id, week.id, otherMarket.id))
      .rejects.toMatchObject({ code: 'WEEK_FROZEN' });

    // The locked pick itself is preserved exactly.
    const after = await prisma.pick.findUniqueOrThrow({ where: { id: pick.id } });
    expect(after.state).toBe('LOCKED');
  });

  it('tells every member the ticket is confirmed', async () => {
    await lockAllen();
    const ticket = await newTicket();
    await addLeg(ticket.id);
    await verifyTicket(ticket.id);
    await confirmOfficialParlay(ticket.id, admin.id);

    const alerts = await prisma.notification.findMany({ where: { kind: 'OFFICIAL' } });
    expect(alerts).toHaveLength(2);   // both active members
  });
});

describe('ACCEPTANCE (spec §62, §97): live results update The Sweat and the record', () => {
  it('grades a threshold prop from the official ticket and shows it in The Sweat', async () => {
    await lockAllen(-175, 25);
    const ticket = await newTicket();
    const leg = await addLeg(ticket.id, { americanOdds: -205 });
    await verifyTicket(ticket.id);
    await confirmOfficialParlay(ticket.id, admin.id);

    // Josh Allen finishes with 32 rushing yards.
    const graded = await gradeOfficialLeg(leg.id, 32, { automatic: true });
    expect(graded.result).toBe('WIN');

    const board = await sweatBoard(week.id);
    if (!board.available) throw new Error('sweat board should be available');
    expect(board.counts.won).toBe(1);
    expect(board.legs[0].bettor).toBe('Tanner');
    expect(board.legs[0].state).toBe('WON');
    expect(board.legs[0].current).toBe(32);

    // The member is told.
    const alert = await prisma.notification.findFirst({ where: { userId: tanner.id, kind: 'RESULT' } });
    expect(alert!.body).toContain('won');
  });

  it('shows how much more is needed while a leg is live (spec §60)', async () => {
    await lockAllen();
    const ticket = await newTicket();
    const leg = await addLeg(ticket.id, { subjectLabel: 'Patrick Mahomes', line: 225, marketKey: 'PASSING_YARDS', selectionLabel: '225+ Passing Yards', descriptionText: 'Patrick Mahomes 225+ Passing Yards' });
    await verifyTicket(ticket.id);
    await prisma.officialTicketLeg.update({ where: { id: leg.id }, data: { actualValue: 198, userId: tanner.id } });
    await prisma.officialTicket.update({ where: { id: ticket.id }, data: { status: 'CONFIRMED', confirmedAt: new Date() } });

    const board = await sweatBoard(week.id);
    if (!board.available) throw new Error('unavailable');
    expect(board.legs[0].needed).toBe('NEEDS 27 MORE');
  });

  it('records bad-beat detail on a near miss (spec §63)', async () => {
    await lockAllen();
    const ticket = await newTicket();
    const leg = await addLeg(ticket.id, { subjectLabel: 'Justin Jefferson', line: 75, marketKey: 'RECEIVING_YARDS', selectionLabel: '75+ Receiving Yards' });
    await verifyTicket(ticket.id);

    await gradeOfficialLeg(leg.id, 74, { automatic: true });
    const after = await prisma.officialTicketLeg.findUniqueOrThrow({ where: { id: leg.id } });
    expect(after.result).toBe('LOSS');
    expect(Number(after.margin)).toBe(-1);
    expect(after.resultNarrative).toBe('MISSED BY 1 UNIT');
  });

  it('marks an ungradeable market AWAITING MANUAL GRADING rather than guessing', async () => {
    await lockAllen();
    const ticket = await newTicket();
    const leg = await addLeg(ticket.id, { marketKey: 'FIRST_TO_15_POINTS', selectionLabel: 'Bills First to 15 Points', line: undefined as never });
    await prisma.officialTicketLeg.update({ where: { id: leg.id }, data: { line: null } });

    const graded = await gradeOfficialLeg(leg.id, null, { automatic: true });
    expect(graded.awaitingManualGrading).toBe(true);
    expect(graded.result).toBe('PENDING');

    // The administrator decides, and it is audited.
    await manuallyGradeLeg({ legId: leg.id, result: 'WIN', actorId: admin.id, reason: 'Confirmed from the box score: Buffalo reached 15 first.' });
    const after = await prisma.officialTicketLeg.findUniqueOrThrow({ where: { id: leg.id }, include: { audits: true } });
    expect(after.result).toBe('WIN');
    expect(after.gradedManually).toBe(true);
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0].reason).toContain('box score');
  });

  it('highlights the final leg when nine of ten have won (spec §61)', async () => {
    await lockAllen();
    const ticket = await newTicket();
    for (let i = 0; i < 10; i++) {
      const leg = await addLeg(ticket.id, { legIndex: i, americanOdds: -150 });
      if (i < 9) await prisma.officialTicketLeg.update({ where: { id: leg.id }, data: { result: 'WIN' } });
    }
    await prisma.officialTicket.update({ where: { id: ticket.id }, data: { status: 'CONFIRMED', confirmedAt: new Date() } });

    const board = await sweatBoard(week.id);
    if (!board.available) throw new Error('unavailable');
    expect(board.counts.won).toBe(9);
    expect(board.finalLeg).not.toBeNull();
    expect(board.finalLeg!.legIndex).toBe(9);
  });

  it('settles the parlay once every leg is decided', async () => {
    await lockAllen();
    const ticket = await newTicket();
    for (let i = 0; i < 3; i++) {
      const leg = await addLeg(ticket.id, { legIndex: i });
      await prisma.officialTicketLeg.update({ where: { id: leg.id }, data: { result: i === 2 ? 'LOSS' : 'WIN' } });
    }
    await prisma.officialTicket.update({ where: { id: ticket.id }, data: { status: 'CONFIRMED', confirmedAt: new Date() } });

    const parlay = await settleParlayIfComplete(week.id);
    expect(parlay!.settled).toBe(true);
    expect(parlay!.won).toBe(false);
    expect(parlay!.legsWon).toBe(2);
    expect((await prisma.nFLWeek.findUniqueOrThrow({ where: { id: week.id } })).status).toBe('SETTLED');
  });
});

describe('The Sweat before confirmation', () => {
  it('is unavailable until the official parlay is confirmed', async () => {
    const board = await sweatBoard(week.id);
    expect(board.available).toBe(false);
  });
});
