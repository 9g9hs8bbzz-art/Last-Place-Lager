import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { prisma } from '../lib/prisma.js';
import { resetDatabase } from '../test/fixtures.js';
import { hashPassword } from '../lib/auth.js';
import { buildPreview, applyImport, recordCorrection } from './historicalImport.js';
import { leaderboard, bettorProfile, groupTendencies } from './stats.js';
import { INITIAL_ROSTER, NAMED_CORRECTIONS, averageAmericanOdds, formatAmerican } from '@fcp/shared';

const WORKBOOK = path.resolve(process.cwd(), '../../data/Last_Place_Lagers_First_Class_Parlays.xlsx');

async function seedRosterAndCorrections() {
  const passwordHash = await hashPassword('test-password-1');
  for (const [i, name] of INITIAL_ROSTER.entries()) {
    await prisma.user.create({
      data: { displayName: name, legacyName: name, passwordHash, role: i === 0 ? 'ADMIN' : 'MEMBER' },
    });
  }
  for (const c of NAMED_CORRECTIONS) {
    await prisma.historicalCorrection.create({
      data: {
        entityType: 'HistoricalPick', seasonYear: c.season, weekNumber: c.week, bettorName: c.bettor,
        field: c.field, originalValue: c.originalValue, correctedValue: c.correctedValue,
        reason: c.reason, status: 'APPROVED', canonical: true,
      },
    });
  }
}

beforeAll(async () => {
  await resetDatabase();
  await prisma.historicalCorrection.deleteMany();
  await seedRosterAndCorrections();
  await applyImport(WORKBOOK, 'Last_Place_Lagers_First_Class_Parlays.xlsx', null);
}, 120_000);

afterAll(async () => { await prisma.$disconnect(); });

describe('ACCEPTANCE (spec §80, §84, §97): the cleaned historical baseline', () => {
  it('imports exactly 260 unique picks', async () => {
    expect(await prisma.historicalPick.count()).toBe(260);
  });

  it('splits 110 from 2024 and 150 from 2025', async () => {
    expect(await prisma.historicalPick.count({ where: { seasonYear: 2024 } })).toBe(110);
    expect(await prisma.historicalPick.count({ where: { seasonYear: 2025 } })).toBe(150);
  });

  it('excludes the duplicated 2025 block on the All Time sheet', async () => {
    const preview = await buildPreview(WORKBOOK, 'wb.xlsx');
    expect(preview.duplicatesExcluded).toBe(150);
    // No bettor appears twice for the same season and week.
    const dupes = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) as count FROM (
        SELECT "seasonYear", "weekNumber", "bettorName"
        FROM "HistoricalPick" GROUP BY 1,2,3 HAVING COUNT(*) > 1
      ) d`;
    expect(Number(dupes[0].count)).toBe(0);
  });

  it('ignores the 2026 template sheet entirely', async () => {
    expect(await prisma.historicalPick.count({ where: { seasonYear: 2026 } })).toBe(0);
  });

  it('matches all ten roster members to accounts', async () => {
    const unmatched = await prisma.historicalPick.count({ where: { userId: null } });
    expect(unmatched).toBe(0);
  });

  it('leaves no record silently discarded', async () => {
    const preview = await buildPreview(WORKBOOK, 'wb.xlsx');
    expect(preview.needsReview).toHaveLength(0);
    expect(preview.rows).toHaveLength(260);
  });
});

describe('ACCEPTANCE (spec §81, §97): Week Offs stay intentional', () => {
  it('records 2024 W12 and 2025 W15 as WEEK OFF, not as missing data', async () => {
    const offs = await prisma.nFLWeek.findMany({ where: { status: 'WEEK_OFF' }, include: { season: true } });
    const keys = offs.map((w) => `${w.season.year} W${w.weekNumber}`);
    expect(keys).toContain('2024 W12');
    expect(keys).toContain('2025 W15');
    for (const off of offs) expect(off.weekOffReason).toBeTruthy();
  });

  it('never treats a Week Off as an 0-0 record', async () => {
    const off = await prisma.nFLWeek.findFirstOrThrow({ where: { status: 'WEEK_OFF' }, include: { season: true } });
    const picks = await prisma.historicalPick.count({ where: { seasonYear: off.season.year, weekNumber: off.weekNumber } });
    expect(picks).toBe(0);
  });

  it('records 2024 Week 6 as a played week — the decision is settled, not re-flagged', async () => {
    // The specification originally listed 2024 Week 6 as a Week Off. The group
    // reviewed it and confirmed the week WAS played, which is also what the
    // 110/260 totals require. The importer must now treat it as an ordinary
    // settled week and must NOT raise the old disagreement again.
    expect(await prisma.historicalPick.count({ where: { seasonYear: 2024, weekNumber: 6 } })).toBe(10);

    const week = await prisma.nFLWeek.findFirstOrThrow({
      where: { weekNumber: 6, season: { year: 2024 } },
      include: { season: true },
    });
    expect(week.status).not.toBe('WEEK_OFF');
    expect(week.weekOffReason).toBeNull();

    const conflict = await prisma.importConflict.findFirst({ where: { scope: 'WEEK_OFF_HAS_DATA', seasonYear: 2024, weekNumber: 6 } });
    expect(conflict).toBeNull();
  });
});

describe('ACCEPTANCE (spec §82, §97): accepted corrections are applied', () => {
  it('uses the corrected Bears @ Raiders matchup', async () => {
    const row = await prisma.historicalPick.findFirstOrThrow({ where: { seasonYear: 2025, weekNumber: 4, bettorName: 'Tanner' } });
    expect(row.matchupText).toBe('Bears @ Raiders');
    expect(row.pickText).toContain('C. Williams');
  });

  it('restores Lions 40 - 49ers 34 and keeps Dan\'s WIN', async () => {
    const row = await prisma.historicalPick.findFirstOrThrow({ where: { seasonYear: 2024, weekNumber: 17, bettorName: 'Dan' } });
    expect(row.outcomeText).toBe('40-34');
    expect(row.result).toBe('WIN');
    expect(row.pickText).toBe('Lions -3.5');
  });

  it('restores the Justin Herbert / Chargers result', async () => {
    const row = await prisma.historicalPick.findFirstOrThrow({ where: { seasonYear: 2025, weekNumber: 9, bettorName: 'Austin' } });
    expect(row.outcomeText).toContain('2 Pass TDs');
    expect(row.result).toBe('WIN');
  });

  it('restores all 19 Excel date-mangled scores', async () => {
    const preview = await buildPreview(WORKBOOK, 'wb.xlsx');
    expect(preview.scoresRestored).toBe(19);
    // Spot-check both seasons.
    const austin = await prisma.historicalPick.findFirstOrThrow({ where: { seasonYear: 2025, weekNumber: 1, bettorName: 'Austin' } });
    expect(austin.outcomeText).toBe('21-6');
    const jake = await prisma.historicalPick.findFirstOrThrow({ where: { seasonYear: 2024, weekNumber: 15, bettorName: 'Jake' } });
    expect(jake.outcomeText).toBe('30-12');
    // And no score cell was left looking like a date.
    const stillDates = await prisma.historicalPick.count({ where: { outcomeText: { contains: 'T00:00:00' } } });
    expect(stillDates).toBe(0);
  });
});

describe('ACCEPTANCE (spec §83, §97): corrections survive a re-import', () => {
  it('keeps an administrator correction after the raw workbook is imported again', async () => {
    const admin = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } });

    // An administrator fixes a matchup label by hand.
    await recordCorrection({
      seasonYear: 2025, weekNumber: 2, bettorName: 'Jake',
      field: 'matchup', correctedValue: 'Bills @ Jets (corrected by admin)',
      reason: 'Verified against the box score.', actorId: admin.id,
    });

    const before = await prisma.historicalPick.findFirstOrThrow({ where: { seasonYear: 2025, weekNumber: 2, bettorName: 'Jake' } });
    expect(before.matchupText).toBe('Bills @ Jets (corrected by admin)');

    // The original, uncorrected spreadsheet is imported all over again.
    await applyImport(WORKBOOK, 'Last_Place_Lagers_First_Class_Parlays.xlsx', admin.id);

    const after = await prisma.historicalPick.findFirstOrThrow({ where: { seasonYear: 2025, weekNumber: 2, bettorName: 'Jake' } });
    expect(after.matchupText).toBe('Bills @ Jets (corrected by admin)');   // NOT reverted

    // And the disagreement was recorded rather than hidden.
    const conflicts = await prisma.importConflict.findMany({ where: { bettorName: 'Jake', field: 'matchup' } });
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0].resolution).toBe('ACCEPTED_CORRECTION_WINS');
  });

  it('still has exactly 260 picks after the re-import', async () => {
    expect(await prisma.historicalPick.count()).toBe(260);
  });

  it('stores who made each correction, when and why', async () => {
    const c = await prisma.historicalCorrection.findFirstOrThrow({ where: { bettorName: 'Jake', field: 'matchup' } });
    expect(c.reason).toBe('Verified against the box score.');
    expect(c.createdById).not.toBeNull();
    expect(c.originalValue).toBe('Bills @ Jets');
    expect(c.status).toBe('APPROVED');
  });
});

describe('ACCEPTANCE (spec §65, §97): average odds match the spreadsheet exactly', () => {
  /**
   * These targets are the workbook's own computed cells for the all-time
   * cumulative row. Reproducing them to six decimal places proves the app uses
   * the group's established method rather than a naive average.
   */
  const WORKBOOK_ALL_TIME = [
    { name: 'Austin',  averageOdds: -119.826417,  profit: 9.969587307,  wins: 15, losses: 11 },
    { name: 'Carson',  averageOdds: -130.8393487, profit: 33.88045097,  wins: 17, losses: 9 },
    { name: 'Clayton', averageOdds: -123.8106534, profit: -26.29181994, wins: 13, losses: 13 },
  ];

  it.each(WORKBOOK_ALL_TIME)('reproduces the workbook figures for $name', async ({ name, averageOdds, profit, wins, losses }) => {
    const board = await leaderboard();
    const row = board.find((r) => r.displayName === name)!;
    expect(row.wins).toBe(wins);
    expect(row.losses).toBe(losses);
    expect(row.averageOdds!).toBeCloseTo(averageOdds, 4);
    expect(row.profit).toBeCloseTo(profit, 6);
  });

  it('is demonstrably not a raw average of the American prices', async () => {
    const picks = await prisma.historicalPick.findMany({ where: { bettorName: 'Carson' } });
    const odds = picks.map((p) => p.americanOdds);
    const naive = odds.reduce((a, b) => a + b, 0) / odds.length;
    const correct = averageAmericanOdds(odds)!;
    expect(correct).toBeCloseTo(-130.8393487, 4);
    expect(Math.abs(correct - naive)).toBeGreaterThan(1); // the two methods really do differ
  });

  it('formats average odds for display without inventing precision', async () => {
    const board = await leaderboard(2025);
    expect(formatAmerican(board[0].averageOdds)).toMatch(/^[+-]\d+$/);
  });
});

describe('statistics are descriptive, never predictive (spec §73)', () => {
  it('ships the disclaimer with group tendencies and always states sample size', async () => {
    const t = await groupTendencies();
    expect(t.disclaimer).toContain('do not predict');
    for (const n of t.notes) expect(n.sampleSize).toBeGreaterThan(0);
  });

  it('builds a bettor profile with market, team and odds breakdowns (spec §68)', async () => {
    const profile = await bettorProfile('Tanner');
    expect(profile!.allTime.total).toBe(26);
    expect(profile!.bySeason[2024].total).toBe(11);
    expect(profile!.bySeason[2025].total).toBe(15);
    expect(profile!.byMarket.length).toBeGreaterThan(1);
    expect(profile!.byOddsRange.length).toBeGreaterThan(0);
    expect(profile!.favouriteVsUnderdog.length).toBeGreaterThan(0);
    // Every breakdown row carries its own sample size.
    for (const m of profile!.byMarket) expect(m.total).toBeGreaterThan(0);
  });
});
