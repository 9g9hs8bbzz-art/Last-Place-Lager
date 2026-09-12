import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { env, assertProductionSecrets } from './lib/env.js';
import { prisma } from './lib/prisma.js';
import { authRoutes } from './routes/auth.js';
import { pickRoutes } from './routes/picks.js';
import { appRoutes } from './routes/public.js';
import { adminRoutes } from './routes/admin.js';
import { startScheduler, stopScheduler } from './services/scheduler.js';

export async function buildServer() {
  assertProductionSecrets();

  const app = Fastify({
    logger: { level: env.isProduction ? 'info' : 'warn' },
    bodyLimit: 15 * 1024 * 1024,
  });

  await app.register(cors, { origin: env.isProduction ? [env.publicAppUrl] : true, credentials: true });
  await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024, files: 1 } });

  app.get('/health', async () => ({ ok: true, service: 'first-class-parlays-api', time: new Date().toISOString() }));

  /**
   * Legal and responsible-gambling notices, served from the API so the future
   * mobile client shows exactly the same text (spec §92).
   */
  app.get('/api/legal', async () => ({
    adultsOnly: 'You must be 21 or older to use this application.',
    notASportsbook:
      'First Class Parlays is a private record-keeping and research tool for one group of friends. It is not Sports Bet Montana, it is not affiliated with Sports Bet Montana, and it is not a sportsbook. No wager can be placed, no money can be deposited or withdrawn, and no winnings are distributed through this application. All wagers are placed by one group member in person or through their own Sports Bet Montana account.',
    responsibleGambling:
      'If gambling stops being entertainment, help is available. Call or text the National Problem Gambling Helpline at 1-800-522-4700, available 24 hours a day, or visit ncpgambling.org. Montana residents can also reach the Montana Council on Problem Gambling at 1-888-900-9979.',
    privacy:
      'This application is private to the group. Account details, picks and uploaded ticket images are visible only to signed-in members, and administrative functions only to the parlay manager. Sportsbook credentials are never requested, collected or stored.',
  }));

  await app.register(authRoutes, { prefix: '/api' });
  await app.register(appRoutes, { prefix: '/api' });
  await app.register(pickRoutes, { prefix: '/api' });
  await app.register(adminRoutes, { prefix: '/api' });

  // Serve the built web client from the same process, so a deployment is one
  // service rather than two. Registered AFTER the API routes so /api always
  // wins, and with a single-page-app fallback so a deep link like /picks or
  // /admin opens correctly on a refresh.
  // src/server.ts in development, dist/server.js in production — both sit two
  // levels below apps/web/dist.
  const hereDir = path.dirname(fileURLToPath(import.meta.url));
  const webDist = env.webDistDir
    ? path.resolve(env.webDistDir)
    : path.resolve(hereDir, '..', '..', 'web', 'dist');
  if (existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, index: false, wildcard: false });

    app.setNotFoundHandler((req, reply) => {
      // An unmatched /api path is a genuine 404, not a page.
      if (req.url.startsWith('/api/') || req.url === '/health') {
        return reply.code(404).send({ error: 'NOT_FOUND', message: 'No such endpoint.' });
      }
      // Anything else is a client route: hand back the app shell.
      return reply.sendFile('index.html');
    });

    app.log.info(`Serving the web client from ${webDist}`);
  } else {
    app.log.warn(
      `No built web client found at ${webDist}. The API will run, but nothing will be served at the root. ` +
        'Run "npm run build" first.',
    );
  }

  app.setErrorHandler((error: { statusCode?: number; message?: string }, _req, reply) => {
    app.log.error(error as Error);
    // Internal details never reach the client.
    const isClientError = typeof error.statusCode === 'number' && error.statusCode < 500;
    reply.code(isClientError ? error.statusCode! : 500).send({
      error: 'SERVER_ERROR',
      message: isClientError ? error.message : 'Something went wrong. Please try again.',
    });
  });

  return app;
}

const isDirectRun = process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');
if (isDirectRun) {
  const app = await buildServer();
  try {
    await app.listen({ port: env.port, host: '0.0.0.0' });
    console.log(`First Class Parlays API listening on http://localhost:${env.port}`);
    // Background work starts only for a real server process, never for tests
    // or one-off scripts that import buildServer().
    startScheduler();

    // Uploaded ticket images are the group's authoritative record of what was
    // wagered, and most hosting platforms wipe the filesystem on every
    // redeploy. Say so loudly rather than letting them quietly disappear.
    if (env.isProduction && !process.env.UPLOAD_DIR) {
      console.warn(
        '[uploads] UPLOAD_DIR is not set. Ticket images are being written inside the application ' +
          'directory, which most hosts erase on redeploy. Attach a persistent volume and point ' +
          'UPLOAD_DIR at it — see docs/SETUP.md.',
      );
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
      stopScheduler();
      await app.close();
      await prisma.$disconnect();
      process.exit(0);
    });
  }
}
