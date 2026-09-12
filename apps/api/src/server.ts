import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
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
