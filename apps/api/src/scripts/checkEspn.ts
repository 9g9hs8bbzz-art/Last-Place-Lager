/**
 * Check that ESPN is reachable and still shaped the way the app expects.
 *
 * ESPN's endpoints are unofficial, so this is the one command to run when
 * something looks wrong: it prints exactly what came back, and says plainly
 * whether the app can read it.
 *
 *   npm run check:espn            (current week)
 *   npm run check:espn -- 2025 6  (a specific season and week)
 */
import { EspnProvider } from '../providers/espn.js';
import { currentNflWeek } from '../services/scheduleSync.js';
import { isDataUnavailable } from '@fcp/shared';

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const now = currentNflWeek();
  const season = args[0] ? Number(args[0]) : now.seasonYear;
  const week = args[1] ? Number(args[1]) : now.weekNumber;

  const espn = new EspnProvider();
  console.log(`\nChecking ESPN for ${season} week ${week}…\n`);

  const schedule = await espn.getWeekSchedule(season, week);
  if (isDataUnavailable(schedule)) {
    console.log('SCHEDULE:  could not be read');
    console.log(`           ${schedule.reason}`);
    console.log('\nThe app will show "DATA CURRENTLY UNAVAILABLE" and you can add games by hand.');
    console.log('If this keeps happening, ESPN may have changed their endpoint.\n');
    process.exit(1);
  }

  console.log(`SCHEDULE:  OK — ${schedule.data.length} games\n`);
  for (const g of schedule.data) {
    const day = g.kickoffAt.toUTCString().slice(0, 3);
    console.log(
      `  ${g.awayTeamAbbrev.padEnd(3)} @ ${g.homeTeamAbbrev.padEnd(3)}  ${day} ${g.kickoffAt.toISOString().slice(0, 16)}  ` +
        `${g.indoor ? 'indoor ' : '       '}${g.venue ?? ''}`,
    );
  }

  const live = await espn.getGameStates(schedule.data.map((g) => g.providerGameId));
  console.log(
    `\nLIVE:      ${isDataUnavailable(live) ? `could not be read — ${live.reason}` : `OK — ${live.data.length} games matched`}`,
  );

  const first = schedule.data[0];
  if (first) {
    const stats = await espn.getPlayerStats(first.providerGameId);
    if (isDataUnavailable(stats)) {
      console.log(`BOX SCORE: none yet for ${first.awayTeamAbbrev} @ ${first.homeTeamAbbrev} — ${stats.reason}`);
      console.log('           (normal before kickoff)');
    } else {
      console.log(`BOX SCORE: OK — ${stats.data.length} player statistics readable`);
      for (const s of stats.data.slice(0, 5)) console.log(`             ${s.playerName}: ${s.statKey} = ${s.value}`);
    }
  }

  console.log('\nESPN looks healthy. Nothing to do.\n');
}

main().catch((e) => {
  console.error('\nThe check itself failed:', e instanceof Error ? e.message : e, '\n');
  process.exit(1);
});
