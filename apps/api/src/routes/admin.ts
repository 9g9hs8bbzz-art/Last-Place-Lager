import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs/promises';
import { prisma } from '../lib/prisma.js';
import { requireAdmin, hashPassword } from '../lib/auth.js';
import { env } from '../lib/env.js';
import { audit } from '../lib/audit.js';
import { getGuideline, setGuideline, getReaderSettings, setReaderSettings } from '../lib/settings.js';
import { parlayReadiness, readerHealth, detectLockedPickIssues } from '../services/marketMonitor.js';
import { setWeekOff, clearWeekOff, recomputeWeekStatus } from '../services/weeks.js';
import { uploadTicket, verifyTicket, confirmOfficialParlay, resolveLeg, extractTicket, TicketError } from '../services/tickets.js';
import { manuallyGradeLeg, gradeOfficialLeg, refreshLive } from '../services/live.js';
import { buildPreview, applyImport, recordCorrection } from '../services/historicalImport.js';
import { runScan, linkEventsToGames } from '../services/readerRun.js';
import { boardReader, ticketOcrProvider, liveScoreProvider, integrationStatus } from '../providers/registry.js';
import { selectionKeyOf, normalizeKey, parseAmerican, type MarketCategory } from '@fcp/shared';

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin);

  // -------------------------------------------------------------- roster

  app.get('/admin/users', async () => ({
    users: await prisma.user.findMany({ orderBy: { displayName: 'asc' }, select: { id: true, displayName: true, email: true, role: true, active: true, legacyName: true } }),
  }));

  app.post('/admin/users', async (req, reply) => {
    const body = z
      .object({
        displayName: z.string().min(1),
        password: z.string().min(10, 'Use at least 10 characters.'),
        role: z.enum(['MEMBER', 'ADMIN']).default('MEMBER'),
        email: z.string().email().optional(),
        legacyName: z.string().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: body.error.issues[0]?.message });

    const user = await prisma.user.create({
      data: {
        displayName: body.data.displayName,
        email: body.data.email,
        role: body.data.role,
        legacyName: body.data.legacyName ?? body.data.displayName,
        passwordHash: await hashPassword(body.data.password),
      },
    });
    await audit({ actorId: req.user!.sub, action: 'USER_CREATED', entityType: 'User', entityId: user.id, summary: `Added ${user.displayName} to the roster` });
    return { id: user.id, displayName: user.displayName, role: user.role };
  });

  app.patch('/admin/users/:id', async (req, reply) => {
    const body = z
      .object({ displayName: z.string().min(1).optional(), role: z.enum(['MEMBER', 'ADMIN']).optional(), active: z.boolean().optional(), password: z.string().min(10).optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: body.error.issues[0]?.message });
    const { id } = req.params as { id: string };

    const user = await prisma.user.update({
      where: { id },
      data: {
        displayName: body.data.displayName,
        role: body.data.role,
        active: body.data.active,
        ...(body.data.password ? { passwordHash: await hashPassword(body.data.password) } : {}),
      },
    });
    await audit({ actorId: req.user!.sub, action: 'USER_UPDATED', entityType: 'User', entityId: id, summary: `Updated ${user.displayName}` });
    return { ok: true };
  });

  // ------------------------------------------------------ seasons & weeks

  app.post('/admin/seasons', async (req, reply) => {
    const body = z.object({ year: z.number().int(), isCurrent: z.boolean().default(false) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'Give the season year, for example 2026.' });
    if (body.data.isCurrent) await prisma.season.updateMany({ data: { isCurrent: false } });
    const season = await prisma.season.upsert({
      where: { year: body.data.year },
      create: { year: body.data.year, label: `${body.data.year} Season`, isCurrent: body.data.isCurrent },
      update: { isCurrent: body.data.isCurrent },
    });
    return season;
  });

  app.post('/admin/weeks', async (req, reply) => {
    const body = z
      .object({ seasonYear: z.number().int(), weekNumber: z.number().int().min(1).max(22), eligibleWeekdays: z.array(z.number().int().min(0).max(6)).optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'Give the season year and week number.' });

    const season = await prisma.season.findUniqueOrThrow({ where: { year: body.data.seasonYear } });
    const week = await prisma.nFLWeek.upsert({
      where: { seasonId_weekNumber: { seasonId: season.id, weekNumber: body.data.weekNumber } },
      create: { seasonId: season.id, weekNumber: body.data.weekNumber, eligibleWeekdays: body.data.eligibleWeekdays ?? [0, 1] },
      update: { ...(body.data.eligibleWeekdays ? { eligibleWeekdays: body.data.eligibleWeekdays } : {}) },
    });
    return week;
  });

  app.post('/admin/weeks/:weekId/week-off', async (req, reply) => {
    const body = z.object({ reason: z.string().min(3) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'Say why the week is being skipped.' });
    return setWeekOff((req.params as { weekId: string }).weekId, body.data.reason, req.user!.sub);
  });

  app.delete('/admin/weeks/:weekId/week-off', async (req) => clearWeekOff((req.params as { weekId: string }).weekId, req.user!.sub));

  /** Open or close individual games for unusual schedules (spec §6). */
  app.patch('/admin/games/:gameId/eligibility', async (req, reply) => {
    const body = z.object({ eligible: z.boolean(), note: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'BAD_REQUEST' });
    const { gameId } = req.params as { gameId: string };
    const game = await prisma.nFLGame.update({ where: { id: gameId }, data: { eligible: body.data.eligible, eligibilityNote: body.data.note } });
    await audit({ actorId: req.user!.sub, action: 'GAME_ELIGIBILITY_CHANGED', entityType: 'NFLGame', entityId: gameId, summary: `Game marked ${body.data.eligible ? 'eligible' : 'not eligible'}` });
    return game;
  });

  app.post('/admin/games', async (req, reply) => {
    const body = z
      .object({
        nflWeekId: z.string(), awayAbbrev: z.string(), homeAbbrev: z.string(),
        kickoffAt: z.string(), providerGameId: z.string().optional(), venue: z.string().optional(), indoor: z.boolean().default(false),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'Check the game details.' });

    const [away, home] = await Promise.all([
      prisma.team.findUnique({ where: { abbreviation: body.data.awayAbbrev.toUpperCase() } }),
      prisma.team.findUnique({ where: { abbreviation: body.data.homeAbbrev.toUpperCase() } }),
    ]);
    if (!away || !home) return reply.code(400).send({ error: 'UNKNOWN_TEAM', message: 'One of those team abbreviations was not recognised.' });

    const kickoff = new Date(body.data.kickoffAt);
    const eligibleDays = (await prisma.nFLWeek.findUniqueOrThrow({ where: { id: body.data.nflWeekId } })).eligibleWeekdays;

    const game = await prisma.nFLGame.create({
      data: {
        nflWeekId: body.data.nflWeekId,
        providerGameId: body.data.providerGameId ?? `${away.abbreviation}-${home.abbreviation}-${kickoff.toISOString().slice(0, 10)}`,
        awayTeamId: away.id, homeTeamId: home.id, kickoffAt: kickoff,
        venue: body.data.venue, indoor: body.data.indoor,
        // Sunday and Monday by default; anything else is visible but not selectable.
        eligible: eligibleDays.includes(kickoff.getUTCDay()),
        eligibilityNote: eligibleDays.includes(kickoff.getUTCDay()) ? null : 'NOT ELIGIBLE FOR THIS WEEK\'S PARLAY',
      },
    });
    await linkEventsToGames(body.data.nflWeekId);
    return game;
  });

  // ------------------------------------------------------------ readiness

  app.get('/admin/weeks/:weekId/readiness', async (req) => {
    const weekId = (req.params as { weekId: string }).weekId;
    const [rows, status] = await Promise.all([parlayReadiness(weekId), recomputeWeekStatus(weekId)]);
    return {
      weekStatus: status,
      rows,
      summary: {
        locked: rows.filter((r) => r.matchupReserved).length,
        total: rows.length,
        actionRequired: rows.filter((r) => r.actionRequired).length,
      },
    };
  });

  // -------------------------------------------------------- reader control

  app.get('/admin/reader', async () => {
    const [health, settings] = await Promise.all([readerHealth(), getReaderSettings()]);
    return {
      ...health,
      settings,
      configured: boardReader.isConfigured(),
      guidance:
        'A complete scan is designed to take 20-30 minutes. That is normal and healthy — the reader deliberately makes one slow request at a time to keep traffic to Sports Bet Montana as low as possible.',
    };
  });

  app.patch('/admin/reader/settings', async (req, reply) => {
    const body = z
      .object({
        enabled: z.boolean().optional(),
        requestBudgetPerRun: z.number().int().min(1).max(500).optional(),
        minDelayMs: z.number().int().min(1000).optional(),
        maxDelayMs: z.number().int().min(1000).optional(),
        removalConfirmations: z.number().int().min(1).max(10).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: body.error.issues[0]?.message });

    // The floor exists so the reader can never be configured into rapid polling.
    if (body.data.minDelayMs !== undefined && body.data.minDelayMs < 1000) {
      return reply.code(400).send({ error: 'DELAY_TOO_SHORT', message: 'The delay between requests cannot be shorter than one second.' });
    }
    const next = await setReaderSettings(body.data, req.user!.sub);
    await audit({ actorId: req.user!.sub, action: 'READER_SETTINGS_CHANGED', summary: 'Board reader settings updated', detail: next });
    return next;
  });

  app.post('/admin/reader/run', async (req, reply) => {
    const weekId = (req.body as { nflWeekId?: string } | undefined)?.nflWeekId;
    // Started in the background: a scan takes tens of minutes by design.
    void runScan(boardReader, { nflWeekId: weekId }).catch((e) => app.log.error(e));
    return reply.code(202).send({ started: true, message: 'Scan started. It is expected to take 20-30 minutes.' });
  });

  app.post('/admin/reader/resume', async (req) => {
    await prisma.readerCircuitBreaker.update({
      where: { id: 'sbm' },
      data: { consecutiveFailures: 0, cooldownUntil: null, openedAt: null, reason: null },
    });
    await audit({ actorId: req.user!.sub, action: 'READER_RESUMED', summary: 'Administrator cleared the reader safety pause' });
    return { resumed: true };
  });

  /** Manual sportsbook entry, clearly labelled as such (spec §35). */
  app.post('/admin/markets/manual', async (req, reply) => {
    const body = z
      .object({
        nflGameId: z.string(), category: z.string(), marketLabel: z.string(), selectionLabel: z.string(),
        subjectLabel: z.string().optional(), line: z.number().nullable().optional(),
        americanOdds: z.union([z.number(), z.string()]), note: z.string().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'Check the wager details.' });

    const odds = parseAmerican(body.data.americanOdds);
    if (odds === null) return reply.code(400).send({ error: 'BAD_ODDS', message: 'Enter the price like -175 or +120.' });

    const game = await prisma.nFLGame.findUniqueOrThrow({ where: { id: body.data.nflGameId }, include: { homeTeam: true, awayTeam: true } });
    const sourceEventId = `MANUAL-${game.providerGameId}`;
    const event = await prisma.sportsbookEvent.upsert({
      where: { sourceEventId },
      create: { sourceEventId, nflGameId: game.id, homeTeamName: game.homeTeam.nickname, awayTeamName: game.awayTeam.nickname, scheduledAt: game.kickoffAt },
      update: {},
    });

    const identity = selectionKeyOf({
      sourceEventId, category: body.data.category as MarketCategory,
      marketKey: normalizeKey(body.data.marketLabel), subjectKey: body.data.subjectLabel ?? null,
      selectionKey: normalizeKey(body.data.selectionLabel), line: body.data.line ?? null,
    });

    const market = await prisma.market.upsert({
      where: { selectionIdentity: identity },
      create: {
        eventId: event.id, category: body.data.category, marketKey: normalizeKey(body.data.marketLabel),
        marketLabel: body.data.marketLabel, subjectKey: body.data.subjectLabel ? normalizeKey(body.data.subjectLabel) : null,
        subjectLabel: body.data.subjectLabel, selectionKey: normalizeKey(body.data.selectionLabel),
        selectionLabel: body.data.selectionLabel, line: body.data.line ?? null, selectionIdentity: identity,
        americanOdds: odds, available: true, source: 'ADMIN_MANUAL',
        manualNote: body.data.note ?? 'Entered by hand by an administrator.',
      },
      update: { americanOdds: odds, available: true, source: 'ADMIN_MANUAL', lastVerifiedAt: new Date(), manualNote: body.data.note },
    });
    await prisma.marketSnapshot.create({ data: { marketId: market.id, americanOdds: odds, line: body.data.line ?? null, available: true, source: 'ADMIN_MANUAL' } });
    await audit({ actorId: req.user!.sub, action: 'MARKET_MANUALLY_ADDED', entityType: 'Market', entityId: market.id, summary: `Manually added ${body.data.selectionLabel}` });
    return market;
  });

  // -------------------------------------------------------- official ticket

  app.post('/admin/weeks/:weekId/ticket', async (req, reply) => {
    const parts = (req as unknown as { file: () => Promise<{ filename: string; mimetype: string; toBuffer: () => Promise<Buffer> } | undefined> }).file;
    const file = typeof parts === 'function' ? await parts.call(req) : undefined;
    if (!file) return reply.code(400).send({ error: 'NO_FILE', message: 'Attach a photo or screenshot of the ticket.' });

    await fs.mkdir(env.uploadDir, { recursive: true });
    const safeName = `ticket-${Date.now()}-${file.filename.replace(/[^\w.-]/g, '_')}`;
    const dest = path.join(env.uploadDir, safeName);
    await fs.writeFile(dest, await file.toBuffer());

    try {
      const ticket = await uploadTicket({
        nflWeekId: (req.params as { weekId: string }).weekId,
        imagePath: dest, mimeType: file.mimetype, uploadedById: req.user!.sub,
      });
      const extraction = await extractTicket(ticket.id, ticketOcrProvider);
      return { ticket, extraction };
    } catch (e) {
      if (e instanceof TicketError) return reply.code(e.httpStatus).send({ error: e.code, message: e.message });
      throw e;
    }
  });

  app.get('/admin/weeks/:weekId/ticket', async (req) => {
    const ticket = await prisma.officialTicket.findUnique({
      where: { nflWeekId: (req.params as { weekId: string }).weekId },
      include: { legs: { orderBy: { legIndex: 'asc' }, include: { user: true, pick: { include: { market: true } } } } },
    });
    return { ticket };
  });

  app.post('/admin/tickets/:ticketId/legs', async (req, reply) => {
    const body = z
      .object({
        legIndex: z.number().int().min(0), descriptionText: z.string().min(1),
        subjectLabel: z.string().optional(), selectionLabel: z.string().optional(),
        marketKey: z.string().optional(), line: z.number().nullable().optional(),
        americanOdds: z.union([z.number(), z.string()]).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'Check the leg details.' });
    const { ticketId } = req.params as { ticketId: string };

    const leg = await prisma.officialTicketLeg.upsert({
      where: { ticketId_legIndex: { ticketId, legIndex: body.data.legIndex } },
      create: {
        ticketId, legIndex: body.data.legIndex, descriptionText: body.data.descriptionText,
        subjectLabel: body.data.subjectLabel, selectionLabel: body.data.selectionLabel,
        marketKey: body.data.marketKey, line: body.data.line ?? null,
        americanOdds: body.data.americanOdds === undefined ? null : parseAmerican(body.data.americanOdds),
      },
      update: {
        descriptionText: body.data.descriptionText, subjectLabel: body.data.subjectLabel,
        selectionLabel: body.data.selectionLabel, marketKey: body.data.marketKey, line: body.data.line ?? null,
        americanOdds: body.data.americanOdds === undefined ? null : parseAmerican(body.data.americanOdds),
      },
    });
    return leg;
  });

  app.post('/admin/tickets/:ticketId/verify', async (req) => verifyTicket((req.params as { ticketId: string }).ticketId));

  app.post('/admin/legs/:legId/resolve', async (req, reply) => {
    const body = z.object({ userId: z.string().nullable(), pickId: z.string().nullable(), note: z.string().min(3) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'Explain how the leg was resolved.' });
    return resolveLeg({ legId: (req.params as { legId: string }).legId, actorId: req.user!.sub, ...body.data });
  });

  app.post('/admin/tickets/:ticketId/confirm', async (req, reply) => {
    try {
      return await confirmOfficialParlay((req.params as { ticketId: string }).ticketId, req.user!.sub);
    } catch (e) {
      if (e instanceof TicketError) return reply.code(e.httpStatus).send({ error: e.code, message: e.message });
      throw e;
    }
  });

  // ------------------------------------------------------------- grading

  app.post('/admin/legs/:legId/grade', async (req, reply) => {
    const body = z
      .object({ result: z.enum(['WIN', 'LOSS', 'PUSH', 'VOID']), reason: z.string().min(3), actualValue: z.number().nullable().optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'Choose a result and give a reason.' });
    return manuallyGradeLeg({ legId: (req.params as { legId: string }).legId, actorId: req.user!.sub, ...body.data });
  });

  app.post('/admin/legs/:legId/auto-grade', async (req, reply) => {
    const body = z.object({ actual: z.number().nullable() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'BAD_REQUEST' });
    return gradeOfficialLeg((req.params as { legId: string }).legId, body.data.actual, { automatic: true, actorId: req.user!.sub });
  });

  app.post('/admin/weeks/:weekId/refresh-live', async (req) =>
    refreshLive((req.params as { weekId: string }).weekId, liveScoreProvider));

  app.post('/admin/weeks/:weekId/check-picks', async (req) =>
    detectLockedPickIssues((req.params as { weekId: string }).weekId));

  // --------------------------------------------------- history & overrides

  app.post('/admin/import/preview', async (req, reply) => {
    const file = await (req as unknown as { file: () => Promise<{ filename: string; toBuffer: () => Promise<Buffer> } | undefined> }).file();
    if (!file) return reply.code(400).send({ error: 'NO_FILE', message: 'Attach the spreadsheet.' });
    await fs.mkdir(env.uploadDir, { recursive: true });
    const dest = path.join(env.uploadDir, `import-${Date.now()}-${file.filename.replace(/[^\w.-]/g, '_')}`);
    await fs.writeFile(dest, await file.toBuffer());

    const preview = await buildPreview(dest, file.filename);
    return { ...preview, rows: undefined, storedPath: dest, rowCount: preview.rows.length };
  });

  app.post('/admin/import/apply', async (req, reply) => {
    const body = z.object({ storedPath: z.string().min(1), fileName: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'Run a preview first.' });
    const result = await applyImport(body.data.storedPath, body.data.fileName, req.user!.sub);
    return { import: result.import, summary: { ...result.preview, rows: undefined, rowCount: result.preview.rows.length } };
  });

  app.get('/admin/imports', async () => ({
    imports: await prisma.historicalImport.findMany({ orderBy: { startedAt: 'desc' }, take: 20, include: { conflicts: true } }),
  }));

  app.get('/admin/corrections', async () => ({
    corrections: await prisma.historicalCorrection.findMany({ orderBy: { createdAt: 'desc' }, include: { createdBy: { select: { displayName: true } } } }),
  }));

  app.post('/admin/corrections', async (req, reply) => {
    const body = z
      .object({
        seasonYear: z.number().int(), weekNumber: z.number().int(), bettorName: z.string().min(1),
        field: z.enum(['matchup', 'outcome', 'result', 'pickText', 'americanOdds']),
        correctedValue: z.string().min(1), reason: z.string().min(3),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: body.error.issues[0]?.message });
    return recordCorrection({ ...body.data, actorId: req.user!.sub });
  });

  app.delete('/admin/corrections/:id', async (req) => {
    const { id } = req.params as { id: string };
    const c = await prisma.historicalCorrection.update({ where: { id }, data: { status: 'REMOVED', removedAt: new Date() } });
    await audit({ actorId: req.user!.sub, action: 'HISTORICAL_CORRECTION_REMOVED', entityType: 'HistoricalCorrection', entityId: id, summary: `Correction removed for ${c.bettorName}` });
    return { removed: true };
  });

  // ------------------------------------------------------ settings & audit

  app.get('/admin/settings', async () => ({ guideline: await getGuideline(), reader: await getReaderSettings(), integrations: integrationStatus() }));

  app.patch('/admin/settings/guideline', async (req, reply) => {
    const body = z
      .object({ minAmerican: z.number(), maxAmerican: z.number(), movementPointsThreshold: z.number().min(0.5).max(50) })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: 'Check the guideline values.' });
    const next = await setGuideline(body.data, req.user!.sub);
    await audit({ actorId: req.user!.sub, action: 'GUIDELINE_CHANGED', summary: `Odds guideline set to ${next.minAmerican}..${next.maxAmerican}`, detail: next });
    return next;
  });

  app.get('/admin/audit', async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }).safeParse(req.query);
    return { entries: await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: q.success ? q.data.limit : 100, include: { actor: { select: { displayName: true } } } }) };
  });
}
