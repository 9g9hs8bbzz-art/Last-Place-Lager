import { prisma } from '../lib/prisma.js';
import { leaderboard, groupTendencies, bettorProfile, seasonAwards } from '../services/stats.js';
import { formatAmerican } from '@fcp/shared';

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);

async function main() {
  for (const label of ['2025', '2024', 'ALL TIME']) {
    const year = label === 'ALL TIME' ? undefined : Number(label);
    const rows = await leaderboard(year);
    console.log(`\n=== ${label} LEADERBOARD ===`);
    console.log('Rk  Bettor    W   L   Win%    AvgOdds   $10 P/L      ROI     Streak');
    rows.forEach((r, i) => {
      console.log(
        `${String(i + 1).padStart(2)}  ${r.displayName.padEnd(8)} ${String(r.wins).padStart(3)} ${String(r.losses).padStart(3)}  ${pct(r.winPct).padStart(6)}  ${formatAmerican(r.averageOdds).padStart(8)}  ${('$' + r.profit.toFixed(2)).padStart(9)}  ${pct(r.roi).padStart(7)}   ${r.currentStreak.kind ?? '-'}${r.currentStreak.length}`,
      );
    });
  }

  const t = await groupTendencies();
  console.log('\n=== GROUP TENDENCIES (descriptive) ===');
  for (const n of t.notes) console.log(`  • ${n.text}`);

  const awards = await seasonAwards(2025);
  console.log('\n=== 2025 SEASON AWARDS ===');
  for (const a of awards) console.log(`  ${a.label.padEnd(26)} ${a.winner.padEnd(9)} ${a.detail}`);

  const profile = await bettorProfile('Tanner');
  console.log('\n=== PROFILE: TANNER ===');
  console.log(`  All-time: ${profile!.allTime.wins}-${profile!.allTime.losses}, avg odds ${formatAmerican(profile!.allTime.averageOdds)}, ROI ${pct(profile!.allTime.roi)}`);
  console.log('  By market:');
  for (const m of profile!.byMarket.slice(0, 6)) {
    console.log(`    ${m.label.padEnd(18)} ${m.wins}-${m.losses}  (${pct(m.winPct)})  avg ${formatAmerican(m.averageOdds)}`);
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
