/** Configuration, read once at startup. Nothing here is ever sent to the browser. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnvFile } from 'dotenv';

/**
 * Load apps/api/.env before anything below reads process.env.
 *
 * The path is resolved relative to this module rather than to the working
 * directory, because npm runs workspace scripts from the workspace folder while
 * a person runs them from the repository root, and a deployment host may start
 * the process from somewhere else again. From src/lib or dist/lib, two levels up
 * is apps/api either way.
 *
 * Real environment variables always win: dotenv does not overwrite a value the
 * host has already set, so a deployment's configuration is never shadowed by a
 * stray .env that shipped in the image.
 */
loadEnvFile({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env'),
  // Without this dotenv prints a promotional banner on every command the group
  // runs, which buries the output the setup guide tells them to read.
  quiet: true,
});


function str(key: string, fallback = ''): string {
  return process.env[key]?.trim() || fallback;
}
function num(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
}
function bool(key: string, fallback = false): boolean {
  const v = process.env[key]?.trim().toLowerCase();
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

export const env = {
  nodeEnv: str('NODE_ENV', 'development'),
  isProduction: str('NODE_ENV') === 'production',
  /** Demo/sample data is permitted ONLY when this is explicitly on (spec §95). */
  demoDataEnabled: bool('FCP_DEMO_DATA', false),

  databaseUrl: str('DATABASE_URL'),
  port: num('API_PORT', 8080),
  publicAppUrl: str('PUBLIC_APP_URL', 'http://localhost:5173'),

  jwtAccessSecret: str('JWT_ACCESS_SECRET', 'dev-access-secret-change-me'),
  jwtRefreshSecret: str('JWT_REFRESH_SECRET', 'dev-refresh-secret-change-me'),
  accessTokenTtl: str('JWT_ACCESS_TTL', '30m'),
  refreshTokenDays: num('JWT_REFRESH_DAYS', 60),

  uploadDir: str('UPLOAD_DIR', 'uploads'),
  /**
   * Where the built web client lives, served by this same process. Empty means
   * "work it out from where this file is", which is more reliable than a path
   * relative to whatever directory the host started us in.
   */
  webDistDir: str('WEB_DIST_DIR'),

  sbm: {
    baseUrl: str('SBM_BOARD_BASE_URL'),
    enabled: bool('SBM_READER_ENABLED', false),
    requestBudgetPerRun: num('SBM_REQUEST_BUDGET_PER_RUN', 60),
    minDelayMs: num('SBM_MIN_DELAY_MS', 10_000),
    maxDelayMs: num('SBM_MAX_DELAY_MS', 30_000),
    userAgent: str('SBM_USER_AGENT', 'FirstClassParlays/1.0 (private group tool)'),
    /** Requests are issued strictly one at a time (spec §18). Not configurable upward. */
    concurrency: 1 as const,
  },

  providers: {
    schedule: str('NFL_SCHEDULE_PROVIDER'),
    scheduleKey: str('NFL_SCHEDULE_API_KEY'),
    statsKey: str('NFL_STATS_API_KEY'),
    liveKey: str('NFL_LIVE_API_KEY'),
    injuryKey: str('INJURY_API_KEY'),
    weatherKey: str('WEATHER_API_KEY'),
    newsKey: str('NEWS_API_KEY'),
    anthropicKey: str('ANTHROPIC_API_KEY'),
    ocrProvider: str('OCR_PROVIDER'),
    ocrKey: str('OCR_API_KEY'),
  },
};

/** Warn loudly in production if the signing secrets were left at their defaults. */
export function assertProductionSecrets(): void {
  if (!env.isProduction) return;
  const weak = ['dev-access-secret-change-me', 'dev-refresh-secret-change-me', 'change-me', 'change-me-too'];
  if (weak.includes(env.jwtAccessSecret) || weak.includes(env.jwtRefreshSecret)) {
    throw new Error(
      'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be set to long random values before running in production. See docs/SETUP.md.',
    );
  }
}
