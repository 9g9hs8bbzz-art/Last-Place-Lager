/**
 * Import the historical workbook.
 *
 * Usage:  npm run import:history -- <path-to-workbook.xlsx> [--apply]
 * Without --apply this only prints the preview and writes nothing (spec §84).
 */
import path from 'node:path';
import { prisma } from '../lib/prisma.js';
import { buildPreview, applyImport } from '../services/historicalImport.js';
import { WORKBOOK_RULES } from '@fcp/shared';

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const filePath = args.find((a) => !a.startsWith('--'));

  if (!filePath) {
    console.error('Please give the path to the workbook, for example:\n  npm run import:history -- data/Last_Place_Lagers_First_Class_Parlays.xlsx');
    process.exit(1);
  }

  // npm runs a workspace script with the workspace as the working directory,
  // so a path typed at the repository root would otherwise resolve against
  // apps/api and not be found. INIT_CWD is the directory npm was invoked from,
  // which is what the person typing the command actually meant.
  const resolved = path.resolve(process.env.INIT_CWD || process.cwd(), filePath);
  const preview = await buildPreview(resolved, path.basename(resolved));

  console.log('\n=================== IMPORT PREVIEW ===================');
  console.log(`Seasons found ............ ${preview.seasonsFound.join(', ')}`);
  console.log(`Weeks found .............. ${preview.weeksFound.length}`);
  console.log(`Unique picks found ....... ${preview.uniquePicksFound}`);
  console.log(`Duplicates excluded ...... ${preview.duplicatesExcluded}`);
  console.log(`Users matched ............ ${preview.usersMatched.length} (${preview.usersMatched.join(', ')})`);
  if (preview.usersUnmatched.length) console.log(`Users NOT matched ........ ${preview.usersUnmatched.join(', ')}`);
  console.log(`Week Offs ................ ${preview.weekOffs.map((w) => `${w.season} W${w.week}`).join(', ')}`);
  console.log(`Corrections applied ...... ${preview.overridesApplied}`);
  console.log(`Scores restored .......... ${preview.scoresRestored}`);
  console.log(`Records needing review ... ${preview.needsReview.length}`);

  for (const season of preview.seasonsFound) {
    const n = preview.rows.filter((r) => r.seasonYear === season).length;
    console.log(`   ${season}: ${n} picks`);
  }

  if (preview.conflicts.length) {
    console.log('\n--- CONFLICTS FLAGGED FOR AUDIT ---');
    for (const c of preview.conflicts) {
      console.log(`  [${c.scope}] ${c.season ?? ''} W${c.week ?? ''} ${c.bettor ?? ''} ${c.field ?? ''}`);
      console.log(`      raw: ${c.rawValue ?? '(blank)'}  ->  accepted: ${c.acceptedValue ?? '(n/a)'}`);
      console.log(`      ${c.detail}`);
    }
  }

  const expected = WORKBOOK_RULES.expectedUniquePicks;
  console.log(
    `\nExpected cleaned baseline: ${expected} unique picks — ` +
      (preview.uniquePicksFound === expected ? 'MATCHED ✓' : `MISMATCH (got ${preview.uniquePicksFound}) ✗`),
  );
  console.log('======================================================\n');

  if (!apply) {
    console.log('Preview only. Nothing was written. Re-run with --apply to import.');
    return;
  }

  const result = await applyImport(resolved, path.basename(resolved), null);
  console.log(`Imported. ${result.preview.uniquePicksFound} picks written. Import id: ${result.import.id}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
