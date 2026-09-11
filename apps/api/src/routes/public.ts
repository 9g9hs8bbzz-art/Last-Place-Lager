import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../lib/auth.js';
import { sweatBoard } from '../services/live.js';
import { leaderboard, bettorProfile, groupParlayStats, groupTendencies, seasonAwards, weeklyAwards, earlyPickValue } from '../services/stats.js';
import { listNotifications, markRead } from '../services/notifications.js';
import { readerHealth } from '../services/marketMonitor.js';
import { freshnessLabel } from '@fcp/shared';

export async function appRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** The current week, so the client never has to guess which one to show. */
  app.get('/current-week', async () => {
    const week =
      (await prisma.nFLWeek.findFirst({
        where: { status: { in: ['IN_PROGRESS', 'ALL_LOCKED', 'ACTION_REQUIRED', 'READY_TO_PLACE', 'TICKET_UPLOADED', 'OFFICIAL', 'LIVE'] } },
        orderBy: [{ season: { year: 'desc' } }, { weekNumber: 'asc' }],
        include: { season: true },
      })) ??
      (await prisma.nFLWeek.findFirst({ orderBy: [{ season: { year: 'desc' } }, { weekNumber: 'desc' } ], include: { season: true } }));

    if (!week) return { week: null, message: 'No NFL week has been set up yet. An administrator can add one from the Admin screen.' };
    return {
      week: {
        id: week.id, weekNumber: week.weekNumber, seasonYear: week.season.year,
        status: week.status, frozen: Boolean(week.frozenAt), weekOffReason: week.weekOffReason,
        eligibleWeekdays: week.eligibleWeekdays,
      },
    };
  });

  app.get('/weeks', async () => {
    const weeks = await prisma.nFLWeek.findMany({ orderBy: [{ season: { year: 'desc' } }, { weekNumber: 'desc' }], include: { season: true }, take: 60 });
    return { weeks: weeks.map((w) => ({ id: w.id, weekNumber: w.weekNumber, seasonYear: w.season.year, status: w.status, weekOffReason: w.weekOffReason })) };
  });

  app.get('/weeks/:weekId/sweat', async (req) => sweatBoard((req.params as { weekId: string }).weekId));

  app.get('/weeks/:weekId/awards', async (req) => ({ awards: await weeklyAwards((req.params as { weekId: string }).weekId) }));

  /** The weekly recap, generated from settled results (spec §76). */
  app.get('/weeks/:weekId/recap', async (req) => {
    const weekId = (req.params as { weekId: string }).weekId;
    const week = await prisma.nFLWeek.findUnique({ where: { id: weekId }, include: { season: true, parlay: true, officialTicket: { include: { legs: { include: { user: true } } } } } });
    if (!week) return { available: false, reason: 'Week not found.' };
    if (week.status === 'WEEK_OFF') return { available: true, weekOff: true, reason: week.weekOffReason };
    if (!week.parlay?.settled) return { available: false, reason: 'This week has not settled yet.' };

    const legs = week.officialTicket?.legs ?? [];
    const awards = await weeklyAwards(weekId);
    const standings = await leaderboard(week.season.year);

    return {
      available: true,
      weekOff: false,
      headline: `WEEK ${week.weekNumber} RECAP`,
      parlay: { legsWon: week.parlay.legsWon, legsLost: week.parlay.legsLost, won: week.parlay.won, combinedAmericanOdds: week.parlay.combinedAmericanOdds },
      results: legs.map((l) => ({ bettor: l.user?.displayName ?? 'Unassigned', description: l.descriptionText, americanOdds: l.americanOdds, result: l.result, narrative: l.resultNarrative })),
      awards,
      standings: standings.slice(0, 10),
    };
  });

  // -------------------------------------------------------------- stats

  app.get('/stats/leaderboard', async (req) => {
    const q = z.object({ season: z.coerce.number().int().optional() }).safeParse(req.query);
    const season = q.success ? q.data.season : undefined;
    return {
      scope: season ? String(season) : 'ALL_TIME',
      rows: await leaderboard(season),
      note: 'Average Odds are calculated by averaging decimal odds and converting back to American, matching the group\'s spreadsheet method.',
    };
  });

  app.get('/stats/profile/:displayName', async (req, reply) => {
    const profile = await bettorProfile((req.params as { displayName: string }).displayName);
    if (!profile) return reply.code(404).send({ error: 'NO_RECORDS', message: 'No records found for that member yet.' });
    return profile;
  });

  app.get('/stats/group', async () => ({ parlays: await groupParlayStats(), tendencies: await groupTendencies() }));

  app.get('/stats/awards', async (req) => {
    const q = z.object({ season: z.coerce.number().int().optional() }).safeParse(req.query);
    return { awards: await seasonAwards(q.success ? q.data.season : undefined), note: 'Awards are for entertainment and describe past results only.' };
  });

  app.get('/stats/early-value', async (req) => {
    const q = z.object({ season: z.coerce.number().int().optional() }).safeParse(req.query);
    return { rows: await earlyPickValue(q.success ? q.data.season : undefined), note: 'Informational only: how locked prices compared with the official ticket prices.' };
  });

  /** Historical parlays browser (spec §5 STATS tab). */
  app.get('/history/picks', async (req) => {
    const q = z
      .object({ season: z.coerce.number().int().optional(), week: z.coerce.number().int().optional(), bettor: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(300) })
      .safeParse(req.query);
    const f = q.success ? q.data : { limit: 300 as const };
    const picks = await prisma.historicalPick.findMany({
      where: {
        ...( 'season' in f && f.season ? { seasonYear: f.season } : {}),
        ...( 'week' in f && f.week ? { weekNumber: f.week } : {}),
        ...( 'bettor' in f && f.bettor ? { bettorName: { equals: f.bettor, mode: 'insensitive' } } : {}),
      },
      orderBy: [{ seasonYear: 'desc' }, { weekNumber: 'desc' }, { bettorName: 'asc' }],
      take: f.limit,
    });
    const weeksOff = await prisma.nFLWeek.findMany({ where: { status: 'WEEK_OFF' }, include: { season: true } });
    return {
      picks,
      weeksOff: weeksOff.map((w) => ({ seasonYear: w.season.year, weekNumber: w.weekNumber, reason: w.weekOffReason })),
    };
  });

  // ------------------------------------------------------- notifications

  app.get('/notifications', async (req) => ({ notifications: await listNotifications(req.user!.sub) }));

  app.post('/notifications/read', async (req, reply) => {
    const body = z.object({ ids: z.array(z.string()) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'BAD_REQUEST' });
    await markRead(req.user!.sub, body.data.ids);
    return { ok: true };
  });

  /** Sportsbook freshness banner, visible to every member (spec §34). */
  app.get('/sportsbook/status', async () => {
    const health = await readerHealth();
    return {
      health: health.health,
      lastSuccessfulScanAt: health.lastSuccessfulScanAt,
      label: health.neverRun
        ? 'Sports Bet Montana odds have not been connected yet — DATA CURRENTLY UNAVAILABLE'
        : freshnessLabel(health.lastSuccessfulScanAt),
      paused: health.circuitBreaker.open,
      note: 'Odds are read on a slow hourly cycle and are never live.',
    };
  });
}
