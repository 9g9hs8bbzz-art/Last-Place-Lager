import { describe, it, expect } from 'vitest';
import {
  restoreScoreFromMangledDate, isMangledScoreCell, isDeclaredWeekOff,
  DECLARED_WEEKS_OFF, NAMED_CORRECTIONS, findNamedCorrections, WORKBOOK_RULES, INITIAL_ROSTER,
} from './historicalRules.js';

describe('ACCEPTANCE (spec §82): Excel date-mangled scores restore exactly', () => {
  // Every one of these is a real affected cell from the supplied workbook.
  const cases: [string, string, string][] = [
    ['2025-06-21', '21-6',  '2025 W1 Austin, Commanders -3.5 (W)'],
    ['2025-10-26', '26-10', '2025 W1 Clayton, Panthers +3.5 (L)'],
    ['2025-09-14', '14-9',  '2025 W1 Jake, Texans +2.5 (L)'],
    ['2025-12-20', '20-12', '2025 W1 Tanner, Broncos -6.5 (W)'],
    ['2025-10-17', '17-10', '2025 W3 Hunter, Texans ML (L)'],
    ['2025-09-23', '23-9',  '2025 W6 Jake, Steelers -5.5 (W)'],
    ['2025-10-20', '20-10', '2025 W7 Jake, Falcons ML (L)'],
    ['2025-09-24', '24-9',  '2025 W7 Trey, Buccaneers +6.5 (L)'],
    ['2025-10-25', '25-10', '2025 W10 Carson, Chargers -2.5 (W)'],
    ['2025-10-07', '7-10',  '2025 W10 Trey, Eagles +4.5 (W)'],
    ['2025-09-16', '16-9',  '2025 W11 Dan, Lions ML (L)'],
    ['2025-06-23', '23-6',  '2025 W12 Carson, Vikings +7.5 (L)'],
    ['2026-06-29', '29-6',  '2025 W16 Hunter, Saints -6.5 (W)'],
    ['2026-09-26', '26-9',  '2025 W16 Taylon, Titans +3.5 (W)'],
    ['2024-12-07', '7-12',  '2024 W10 Taylon, Vikings -6.5 (L)'],
    ['2024-10-06', '6-10',  '2024 W14 Austin, Total Over 39.5 (L)'],
    ['2024-12-30', '30-12', '2024 W15 Jake, Bears +7.5 (L)'],
    ['2024-12-20', '20-12', '2024 W15 Taylon, Dolphins +3.5 (L)'],
    ['2024-10-25', '25-10', '2024 W17 Hunter, Saints ML (L)'],
  ];

  it('covers exactly the 19 accepted restorations', () => {
    expect(cases).toHaveLength(19);
  });

  it.each(cases)('restores %s to "%s"  (%s)', (iso, expected) => {
    expect(restoreScoreFromMangledDate(new Date(`${iso}T00:00:00Z`))).toBe(expected);
  });

  it('recognizes a mangled cell and ignores ordinary text', () => {
    expect(isMangledScoreCell(new Date('2025-06-21T00:00:00Z'))).toBe(true);
    expect(isMangledScoreCell('34-32')).toBe(false);
    expect(isMangledScoreCell(null)).toBe(false);
  });
});

describe('ACCEPTANCE (spec §81, §97): declared Week Offs', () => {
  it('holds exactly the three declared weeks', () => {
    expect(DECLARED_WEEKS_OFF).toEqual([
      { season: 2024, week: 6 },
      { season: 2024, week: 12 },
      { season: 2025, week: 15 },
    ]);
  });
  it('recognizes them', () => {
    expect(isDeclaredWeekOff(2024, 12)).toBe(true);
    expect(isDeclaredWeekOff(2025, 15)).toBe(true);
    expect(isDeclaredWeekOff(2025, 14)).toBe(false);
  });
});

describe('ACCEPTANCE (spec §82): named corrections are canonical', () => {
  it('carries the 2025 Week 4 Bears @ Raiders matchup correction', () => {
    const [c] = findNamedCorrections(2025, 4, 'Tanner');
    expect(c.field).toBe('matchup');
    expect(c.correctedValue).toBe('Bears @ Raiders');
    expect(c.originalValue).toBe('Bengals @ Broncos');
  });
  it('carries the Lions 40 - 49ers 34 restoration with Dan credited a WIN', () => {
    const [c] = findNamedCorrections(2024, 17, 'Dan');
    expect(c.correctedValue).toBe('40-34');
    expect(c.originalValue).toBeNull(); // the raw cell is blank and must stay overridden
  });
  it('carries the Justin Herbert / Chargers restoration', () => {
    const [c] = findNamedCorrections(2025, 9, 'Austin');
    expect(c.correctedValue).toContain('2 Pass TDs');
    expect(c.correctedValue).toContain('Chargers Win');
  });
  it('every correction records a reason for the audit trail', () => {
    for (const c of NAMED_CORRECTIONS) expect(c.reason.length).toBeGreaterThan(20);
  });
});

describe('workbook cleanup constants (spec §80)', () => {
  it('expects 260 unique picks made of 110 from 2024 and 150 from 2025', () => {
    expect(WORKBOOK_RULES.expectedUniquePicks).toBe(260);
    expect(WORKBOOK_RULES.expected2024Picks + WORKBOOK_RULES.expected2025Picks).toBe(260);
  });
  it('ignores the 2026 template sheet', () => {
    expect(WORKBOOK_RULES.ignoredSheets).toContain('2026');
  });
  it('has the ten-man founding roster', () => {
    expect(INITIAL_ROSTER).toHaveLength(10);
    expect(INITIAL_ROSTER).toContain('Austin');
    expect(INITIAL_ROSTER).toContain('Taylon');
  });
});
