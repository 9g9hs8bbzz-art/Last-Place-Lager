import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../lib/auth.js';
import { lockPick, setPendingPick, removePendingPick, unlockPick, PickError } from '../services/picks.js';
import { matchupStatesForWeek, weekBoard } from '../services/weeks.js';
import { getGuideline } from '../lib/settings.js';
import { checkGuideline, freshnessLabel, assessMovement } from '@fcp/shared';
import { marketHistory } from '../services/marketMonitor.js';
import { researchForMarket, groupHistoryForWager } from '../services/research.js';

function handle(error: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
  if (error instanceof PickError) {
    return reply.code(error.httpStatus).send({ error: error.code, message: error.message, detail: error.detail });
  }
  throw error;
}

export async function pickRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** Everything the Home screen needs in one request (spec §5). */
  app.get('/weeks/:weekId/home', async (req) => {
    const { weekId } = req.params as { weekId: string };
    const userId = req.user!.sub;
    const [week, pick, board, guideline] = await Promise.all([
      prisma.nFLWeek.findUnique({ where: { id: weekId }, include: { season: true } }),
      prisma.pick.findFirst({
        where: { nflWeekId: weekId, userId, state: { in: ['PENDING', 'LOCKED'] } },
        include: { market: { include: { event: true } }, nflGame: { include: { homeTeam: true, awayTeam: true } } },
      }),
      weekBoard(weekId, userId),
      getGuideline(),
    ]);
    if (!week) return { error: 'WEEK_NOT_FOUND' };

    const movement =
      pick?.state === 'LOCKED' && pick.lockedAmericanOdds !== null && pick.market.americanOdds !== null
        ? assessMovement(pick.lockedAmericanOdds, pick.market.americanOdds, guideline)
        : null;

    return {
      week: { id: week.id, weekNumber: week.weekNumber, seasonYear: week.season.year, status: week.status, frozen: Boolean(week.frozenAt), weekOffReason: week.weekOffReason },
      myPick: pick
        ? {
            id: pick.id,
            state: pick.state,
            matchup: `${pick.nflGame.awayTeam.nickname} @ ${pick.nflGame.homeTeam.nickname}`,
            kickoffAt: pick.nflGame.kickoffAt,
            marketId: pick.marketId,
            marketLabel: pick.market.marketLabel,
            selectionLabel: pick.market.selectionLabel,
            subjectLabel: pick.market.subjectLabel,
            lockedOdds: pick.lockedAmericanOdds,
            currentOdds: pick.market.americanOdds,
            marketAvailable: pick.market.available,
            marketUnavailable: Boolean(pick.marketUnavailableAt),
            outsideGuidelineNow: pick.market.americanOdds === null ? null : checkGuideline(pick.market.americanOdds, guideline).outsideGuideline,
            movement,
            // Always say when the price was last checked; never imply live odds (spec §34).
            freshness: freshnessLabel(pick.market.lastVerifiedAt),
            lockExplanation: 'Locking reserves the NFL matchup for you. The official Sports Bet Montana ticket later determines the final recorded wager.',
          }
        : null,
      board,
      guideline,
    };
  });

  app.get('/weeks/:weekId/games', async (req) => {
    const { weekId } = req.params as { weekId: string };
    return { games: await matchupStatesForWeek(weekId, req.user!.sub) };
  });

  app.get('/weeks/:weekId/board', async (req) => weekBoard(weekId(req), req.user!.sub));

  /** Sportsbook offerings for one game. */
  app.get('/games/:gameId/markets', async (req) => {
    const { gameId } = req.params as { gameId: string };
    const guideline = await getGuideline();
    const events = await prisma.sportsbookEvent.findMany({
      where: { nflGameId: gameId },
      include: { markets: { orderBy: [{ category: 'asc' }, { marketKey: 'asc' }, { line: 'asc' }] } },
    });

    if (events.length === 0) {
      return { available: false, message: 'DATA CURRENTLY UNAVAILABLE — no Sports Bet Montana offerings have been read for this game yet.', markets: [] };
    }

    const markets = events.flatMap((e) =>
      e.markets.map((m) => ({
        id: m.id,
        category: m.category,
        marketLabel: m.marketLabel,
        subjectLabel: m.subjectLabel,
        selectionLabel: m.selectionLabel,
        line: m.line === null ? null : Number(m.line),
        americanOdds: m.americanOdds,
        available: m.available,
        source: m.source,
        manualNote: m.manualNote,
        outsideGuideline: m.americanOdds === null ? null : checkGuideline(m.americanOdds, guideline).outsideGuideline,
        freshness: freshnessLabel(m.lastVerifiedAt),
      })),
    );
    return { available: true, markets, guideline };
  });

  app.get('/markets/:marketId/research', async (req, reply) => {
    const { marketId } = req.params as { marketId: string };
    const research = await researchForMarket(marketId);
    if (!research) return reply.code(404).send({ error: 'MARKET_NOT_FOUND' });
    const market = await prisma.market.findUniqueOrThrow({ where: { id: marketId } });
    return { ...research, groupHistory: await groupHistoryForWager(market.subjectLabel, market.marketKey) };
  });

  app.get('/markets/:marketId/history', async (req) => {
    const { marketId } = req.params as { marketId: string };
    return { snapshots: await marketHistory(marketId) };
  });

  // ------------------------------------------------------------- watchlist

  app.get('/weeks/:weekId/watchlist', async (req) => {
    const rows = await prisma.watchedPick.findMany({
      where: { nflWeekId: weekId(req), userId: req.user!.sub },
      include: { market: true, nflGame: { include: { homeTeam: true, awayTeam: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const guideline = await getGuideline();
    return {
      // Watching never reserves anything and never counts as a pick (spec §11).
      note: 'Watching a wager does not reserve the matchup and does not count as your pick.',
      items: rows.map((w) => ({
        id: w.id,
        marketId: w.marketId,
        selectionLabel: w.market.selectionLabel,
        subjectLabel: w.market.subjectLabel,
        americanOdds: w.market.americanOdds,
        available: w.market.available,
        outsideGuideline: w.market.americanOdds === null ? null : checkGuideline(w.market.americanOdds, guideline).outsideGuideline,
        matchup: w.nflGame ? `${w.nflGame.awayTeam.nickname} @ ${w.nflGame.homeTeam.nickname}` : null,
        freshness: freshnessLabel(w.market.lastVerifiedAt),
      })),
    };
  });

  app.post('/weeks/:weekId/watchlist', async (req, reply) => {
    const body = z.object({ marketId: z.string().min(1), note: z.string().max(500).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'Choose a wager to watch.' });

    const market = await prisma.market.findUnique({ where: { id: body.data.marketId }, include: { event: true } });
    if (!market) return reply.code(404).send({ error: 'MARKET_NOT_FOUND', message: 'That wager is no longer listed.' });

    const watched = await prisma.watchedPick.upsert({
      where: { userId_marketId: { userId: req.user!.sub, marketId: market.id } },
      create: { userId: req.user!.sub, nflWeekId: weekId(req), nflGameId: market.event.nflGameId, marketId: market.id, note: body.data.note },
      update: { note: body.data.note },
    });
    return { watched: true, id: watched.id };
  });

  app.delete('/watchlist/:id', async (req) => {
    await prisma.watchedPick.deleteMany({ where: { id: (req.params as { id: string }).id, userId: req.user!.sub } });
    return { removed: true };
  });

  // ----------------------------------------------------------- pending/lock

  app.post('/weeks/:weekId/pending-pick', async (req, reply) => {
    const body = z.object({ marketId: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'Choose a wager.' });
    try {
      const pick = await setPendingPick(req.user!.sub, weekId(req), body.data.marketId);
      return { pick, note: 'This is a pending pick. It does not reserve the matchup until you lock it.' };
    } catch (e) {
      return handle(e, reply);
    }
  });

  app.delete('/weeks/:weekId/pending-pick', async (req, reply) => {
    try {
      return await removePendingPick(req.user!.sub, weekId(req));
    } catch (e) {
      return handle(e, reply);
    }
  });

  /** Check a price against the guideline before committing (spec §30). */
  app.get('/markets/:marketId/guideline-check', async (req, reply) => {
    const market = await prisma.market.findUnique({ where: { id: (req.params as { marketId: string }).marketId } });
    if (!market) return reply.code(404).send({ error: 'MARKET_NOT_FOUND' });
    if (market.americanOdds === null) return { outsideGuideline: null, message: null };
    const guideline = await getGuideline();
    const check = checkGuideline(market.americanOdds, guideline);
    return { ...check, confirmRequired: check.outsideGuideline, actions: check.outsideGuideline ? ['SELECT ANYWAY', 'GO BACK'] : [] };
  });

  app.post('/weeks/:weekId/lock', async (req, reply) => {
    const body = z
      .object({ marketId: z.string().min(1), acknowledgeOutsideGuideline: z.boolean().optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'Choose a wager to lock.' });

    try {
      const result = await lockPick({
        userId: req.user!.sub,
        nflWeekId: weekId(req),
        marketId: body.data.marketId,
        acknowledgeOutsideGuideline: body.data.acknowledgeOutsideGuideline,
      });
      return {
        locked: true,
        pickId: result.pick.id,
        matchup: `${result.pick.nflGame.awayTeam.nickname} @ ${result.pick.nflGame.homeTeam.nickname}`,
        lockedOdds: result.pick.lockedAmericanOdds,
        outsideGuideline: result.outsideGuideline,
        guidelineMessage: result.guidelineMessage,
        message: 'LOCKED — MATCHUP RESERVED',
      };
    } catch (e) {
      return handle(e, reply);
    }
  });

  app.post('/weeks/:weekId/unlock', async (req, reply) => {
    try {
      const result = await unlockPick(req.user!.sub, weekId(req));
      return { ...result, message: 'Matchup released back to the group.' };
    } catch (e) {
      return handle(e, reply);
    }
  });
}

function weekId(req: { params: unknown }): string {
  return (req.params as { weekId: string }).weekId;
}
