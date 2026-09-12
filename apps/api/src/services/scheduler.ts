/**
 * The background clock (spec §17, §88).
 *
 * Four jobs run on their own timers so the group never has to maintain data:
 *
 *   - the Sports Bet Montana board reader, once an hour during the selection
 *     period and never faster;
 *   - live scores and player statistics while games are actually in progress;
 *   - locked-pick monitoring, which raises the odds-movement and
 *     market-unavailable alerts;
 *   - next-week setup, which creates the following week and pulls its slate
 *     once the current one has settled.
 *
 * Everything here is a guard rail rather than a convenience. Each job refuses
 * to overlap with itself, the reader additionally obeys its own circuit
 * breaker and request budget, and a job that throws is logged and skipped
 * rather than taking the process down.
 */
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { getReaderSettings } from '../lib/settings.js';
import { runScan } from './readerRun.js';
import { detectLockedPickIssues } from './marketMonitor.js';
import { refreshLive } from './live.js';
import { ensureWeekAndSync, currentNflWeek } from './scheduleSync.js';
import { boardReader, liveScoreProvider, scheduleProvider } from '../providers/registry.js';

type Job = 'reader' | 'live' | 'picks' | 'nextWeek';

const INTERVALS: Record<Job, number> = {
  // Once an hour. The reader's own pacing makes a scan take 20-30 minutes, so
  // this must never be shortened (spec §17).
  reader: 60 * 60_000,
  // While games are on, every two minutes is enough for The Sweat and costs
  // ESPN one scoreboard request.
  live: 2 * 60_000,
  // Cheap and local: no external requests, just comparing stored state.
  picks: 10 * 60_000,
  nextWeek: 6 * 60 * 60_000,
};

const running = new Set<Job>();
const timers: NodeJS.Timeout[] = [];
let started = false;

export interface SchedulerStatus {
  started: boolean;
  jobs: { job: Job; everyMinutes: number; running: boolean }[];
}

export function schedulerStatus(): SchedulerStatus {
  return {
    started,
    jobs: (Object.keys(INTERVALS) as Job[]).map((job) => ({
      job,
      everyMinutes: Math.round(INTERVALS[job] / 60_000),
      running: running.has(job),
    })),
  };
}

/**
 * Run a job unless it is already running. A slow scan must never be joined by
 * a second one an hour later.
 */
async function once(job: Job, work: () => Promise<void>): Promise<void> {
  if (running.has(job)) return;
  running.add(job);
  try {
    await work();
  } catch (error) {
    console.error(`[scheduler] ${job} failed:`, error instanceof Error ? error.message : error);
  } finally {
    running.delete(job);
  }
}

/** The week members are currently picking for, if there is one. */
async function activeWeek() {
  return prisma.nFLWeek.findFirst({
    where: { status: { in: ['IN_PROGRESS', 'ALL_LOCKED', 'ACTION_REQUIRED', 'READY_TO_PLACE', 'TICKET_UPLOADED', 'OFFICIAL', 'LIVE'] } },
    orderBy: [{ season: { year: 'desc' } }, { weekNumber: 'asc' }],
    include: { season: true },
  });
}

export async function runReaderJob(): Promise<void> {
  const settings = await getReaderSettings();
  if (!settings.enabled || !boardReader.isConfigured()) return;

  const week = await activeWeek();
  if (!week || week.status === 'WEEK_OFF') return;
  // Once the ticket is confirmed there is nothing left to shop for.
  if (week.frozenAt) return;

  await runScan(boardReader, { nflWeekId: week.id });
}

export async function runLiveJob(): Promise<void> {
  const week = await activeWeek();
  if (!week) return;

  // Only poll when a game is actually in progress or about to be: outside
  // those windows this would be a request for nothing.
  const soon = new Date(Date.now() + 30 * 60_000);
  const worthPolling = await prisma.nFLGame.count({
    where: { nflWeekId: week.id, OR: [{ status: 'IN_PROGRESS' }, { status: 'SCHEDULED', kickoffAt: { lte: soon } }] },
  });
  if (worthPolling === 0) return;

  await refreshLive(week.id, liveScoreProvider);
}

export async function runPicksJob(): Promise<void> {
  const week = await activeWeek();
  if (!week || week.status === 'WEEK_OFF' || week.frozenAt) return;
  await detectLockedPickIssues(week.id);
}

/**
 * Once a week has settled, prepare the next one so members come back to a
 * fresh "YOUR PICK: NONE SELECTED" (spec §77). Historical records are never
 * touched by this.
 */
export async function runNextWeekJob(): Promise<void> {
  if (!scheduleProvider.isConfigured()) return;

  const open = await activeWeek();
  if (open) return; // nothing to do while a week is still live

  const { seasonYear, weekNumber } = currentNflWeek();
  const season = await prisma.season.findUnique({ where: { year: seasonYear } });
  if (season) {
    const already = await prisma.nFLWeek.findUnique({
      where: { seasonId_weekNumber: { seasonId: season.id, weekNumber } },
    });
    // A week an administrator has declared off stays off.
    if (already?.status === 'WEEK_OFF') return;
    if (already && (await prisma.nFLGame.count({ where: { nflWeekId: already.id } })) > 0) return;
  }

  await ensureWeekAndSync(seasonYear, weekNumber, scheduleProvider);
}

/**
 * Start the timers. Safe to call once at boot; calling again does nothing.
 * Set FCP_SCHEDULER=off to run the API with no background work at all, which
 * is what the tests and one-off scripts do.
 */
export function startScheduler(): SchedulerStatus {
  if (started) return schedulerStatus();
  if ((process.env.FCP_SCHEDULER ?? '').trim().toLowerCase() === 'off' || env.nodeEnv === 'test') {
    return schedulerStatus();
  }

  const schedule = (job: Job, work: () => Promise<void>) => {
    const timer = setInterval(() => void once(job, work), INTERVALS[job]);
    // Never hold the process open just for a timer.
    timer.unref?.();
    timers.push(timer);
  };

  schedule('reader', runReaderJob);
  schedule('live', runLiveJob);
  schedule('picks', runPicksJob);
  schedule('nextWeek', runNextWeekJob);

  started = true;
  console.log(
    '[scheduler] started — board reader hourly, live scores every 2 minutes while games are on, ' +
      'pick monitoring every 10 minutes, next-week setup every 6 hours.',
  );
  return schedulerStatus();
}

export function stopScheduler(): void {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
  running.clear();
  started = false;
}
