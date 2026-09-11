/**
 * Seed reference data only: the 32 NFL franchises, the group roster, default
 * settings and award definitions. No games, odds, statistics or results are
 * invented here (spec §95) — those arrive from providers or the historical
 * import.
 */
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/auth.js';
import { NFL_TEAMS } from './nflTeams.js';
import { INITIAL_ROSTER, DEFAULT_GUIDELINE, NAMED_CORRECTIONS } from '@fcp/shared';
import { setGuideline } from '../lib/settings.js';

const AWARD_DEFINITIONS = [
  { awardKey: 'BEST_PICK', label: 'Best Pick', scope: 'WEEK', description: 'Highest-priced winning selection of the week.' },
  { awardKey: 'WORST_PICK', label: 'Worst Pick', scope: 'WEEK', description: 'Shortest-priced losing selection of the week.' },
  { awardKey: 'RISKIEST_PICK', label: 'Riskiest Pick', scope: 'WEEK', description: 'Lowest implied probability selection of the week.' },
  { awardKey: 'SAFEST_PICK', label: 'Safest Pick', scope: 'WEEK', description: 'Highest implied probability selection of the week.' },
  { awardKey: 'BEST_HANDICAPPER', label: 'Best Handicapper', scope: 'WEEK', description: 'Best record and price combination this week.' },
  { awardKey: 'WORST_HANDICAPPER', label: 'Worst Handicapper', scope: 'WEEK', description: 'Worst record and price combination this week.' },
  { awardKey: 'BIGGEST_SWEAT', label: 'Biggest Sweat', scope: 'WEEK', description: 'Winning leg decided by the narrowest margin.' },
  { awardKey: 'CLOSEST_MISS', label: 'Closest Miss', scope: 'WEEK', description: 'Losing leg that missed by the least.' },
  { awardKey: 'BIGGEST_BAD_BEAT', label: 'Biggest Bad Beat', scope: 'WEEK', description: 'Shortest-priced leg lost by the narrowest margin.' },
  { awardKey: 'FIRST_LEG_TO_HIT', label: 'First Leg to Hit', scope: 'WEEK', description: 'Earliest leg to settle as a win.' },
  { awardKey: 'LAST_LEG_TO_HIT', label: 'Last Leg to Hit', scope: 'WEEK', description: 'Final leg to settle as a win.' },
  { awardKey: 'SEASON_BEST_HANDICAPPER', label: 'Best Handicapper', scope: 'SEASON', description: 'Best record over the season.' },
  { awardKey: 'SEASON_WORST_HANDICAPPER', label: 'Worst Handicapper', scope: 'SEASON', description: 'Worst record over the season.' },
  { awardKey: 'BALLSIEST_BETTOR', label: 'Ballsiest Bettor', scope: 'SEASON', description: 'Lowest average implied probability.' },
  { awardKey: 'MOST_CONSERVATIVE', label: 'Most Conservative Bettor', scope: 'SEASON', description: 'Highest average implied probability.' },
  { awardKey: 'BEST_ROI', label: 'Best ROI', scope: 'SEASON', description: 'Best hypothetical $10 return on investment.' },
  { awardKey: 'LONGEST_WIN_STREAK', label: 'Longest Win Streak', scope: 'SEASON', description: 'Most consecutive winning picks.' },
  { awardKey: 'LONGEST_LOSING_STREAK', label: 'Longest Losing Streak', scope: 'SEASON', description: 'Most consecutive losing picks.' },
  { awardKey: 'MR_PLUS_MONEY', label: 'Mr. Plus Money', scope: 'SEASON', description: 'Highest share of plus-money selections.' },
  { awardKey: 'CHALK_KING', label: 'Chalk King', scope: 'SEASON', description: 'Highest share of heavy favorites.' },
  { awardKey: 'PROP_KING', label: 'Prop King', scope: 'SEASON', description: 'Best record on player props.' },
  { awardKey: 'SPREAD_KING', label: 'Spread King', scope: 'SEASON', description: 'Best record on point spreads.' },
  { awardKey: 'TOUCHDOWN_MERCHANT', label: 'Touchdown Merchant', scope: 'SEASON', description: 'Best record on touchdown scorer markets.' },
  { awardKey: 'MONDAY_NIGHT_ASSASSIN', label: 'Monday Night Assassin', scope: 'SEASON', description: 'Best record on Monday games.' },
  { awardKey: 'BEST_EARLY_PICKER', label: 'Best Early Picker', scope: 'SEASON', description: 'Most favourable movement between locked price and official ticket price.' },
  { awardKey: 'OVERTHINKER', label: 'Overthinker', scope: 'SEASON', description: 'Most pick changes before the ticket was placed.' },
];

async function main() {
  console.log('Seeding reference data…');

  for (const team of NFL_TEAMS) {
    await prisma.team.upsert({
      where: { abbreviation: team.abbreviation },
      create: {
        abbreviation: team.abbreviation,
        location: team.location,
        nickname: team.nickname,
        conference: team.conference,
        division: team.division,
        aliases: team.aliases ?? [],
      },
      update: { aliases: team.aliases ?? [] },
    });
  }
  console.log(`  ${NFL_TEAMS.length} NFL teams ready.`);

  // The founding roster. Each member gets a temporary password they are told to
  // change; the first member listed is the parlay manager.
  const tempPassword = process.env.SEED_TEMP_PASSWORD || 'ChangeMe!2026';
  const hash = await hashPassword(tempPassword);
  for (const [index, name] of INITIAL_ROSTER.entries()) {
    await prisma.user.upsert({
      where: { displayName: name },
      create: {
        displayName: name,
        legacyName: name,
        passwordHash: hash,
        role: index === 0 ? 'ADMIN' : 'MEMBER',
      },
      update: { legacyName: name },
    });
  }
  console.log(`  ${INITIAL_ROSTER.length} member accounts ready (temporary password: ${tempPassword}).`);

  await setGuideline(DEFAULT_GUIDELINE);
  console.log(`  Odds guideline set to ${DEFAULT_GUIDELINE.minAmerican} .. +${DEFAULT_GUIDELINE.maxAmerican}.`);

  for (const def of AWARD_DEFINITIONS) {
    await prisma.awardDefinition.upsert({
      where: { awardKey: def.awardKey },
      create: def,
      update: { label: def.label, description: def.description },
    });
  }
  console.log(`  ${AWARD_DEFINITIONS.length} award definitions ready.`);

  // Ship the already-reviewed historical corrections as APPROVED + canonical so
  // that they survive every future re-import without being re-entered (spec §83).
  for (const c of NAMED_CORRECTIONS) {
    await prisma.historicalCorrection.upsert({
      where: {
        entityType_seasonYear_weekNumber_bettorName_field: {
          entityType: 'HistoricalPick',
          seasonYear: c.season,
          weekNumber: c.week,
          bettorName: c.bettor,
          field: c.field,
        },
      },
      create: {
        entityType: 'HistoricalPick',
        seasonYear: c.season,
        weekNumber: c.week,
        bettorName: c.bettor,
        field: c.field,
        originalValue: c.originalValue,
        correctedValue: c.correctedValue,
        reason: c.reason,
        status: 'APPROVED',
        canonical: true,
      },
      update: {},
    });
  }
  console.log(`  ${NAMED_CORRECTIONS.length} canonical historical corrections recorded.`);

  await prisma.readerCircuitBreaker.upsert({
    where: { id: 'sbm' },
    create: { id: 'sbm' },
    update: {},
  });

  console.log('Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
