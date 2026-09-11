/**
 * Canonical historical-migration rules (spec §80-§82).
 *
 * These interpretations have already been reviewed and accepted by the group.
 * They are encoded here so that no future re-import can quietly rediscover,
 * re-litigate or undo them.
 */

/** Sheets in the supplied workbook and what each one actually is. */
export const WORKBOOK_RULES = {
  /** A formatting/template copy with no real picks. Never imported. */
  ignoredSheets: ['2026'] as const,
  /** The dedicated 2025 sheet: 150 valid 2025 pick records. */
  season2025Sheet: '2025',
  /**
   * "All Time" holds 2024 records followed by a duplicate copy of the same 150
   * 2025 records. Rows at or after the 2025 duplicate boundary are excluded.
   */
  allTimeSheet: 'All Time',
  expectedUniquePicks: 260,
  expected2024Picks: 110,
  expected2025Picks: 150,
} as const;

/** Weeks intentionally not played. These are a deliberate status, not missing data (spec §78, §81). */
export interface DeclaredWeekOff {
  season: number;
  week: number;
}

export const DECLARED_WEEKS_OFF: readonly DeclaredWeekOff[] = [
  { season: 2024, week: 6 },
  { season: 2024, week: 12 },
  { season: 2025, week: 15 },
];

export function isDeclaredWeekOff(season: number, week: number): boolean {
  return DECLARED_WEEKS_OFF.some((w) => w.season === season && w.week === week);
}

/**
 * Excel silently reinterpreted score text like "21-6" as the date 21 June.
 * Nineteen such cells were identified and their restoration accepted.
 *
 * The mangling is reversible exactly: Excel read "D-M" as day-month, so the
 * original score text is `${day}-${month}`. Verified against all 19 affected
 * records, every one of which stays consistent with its recorded W/L.
 */
export function restoreScoreFromMangledDate(value: Date): string {
  const day = value.getUTCDate();
  const month = value.getUTCMonth() + 1;
  return `${day}-${month}`;
}

/** True when a spreadsheet outcome cell was date-mangled rather than genuinely a date. */
export function isMangledScoreCell(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * Named record-level corrections already reviewed and accepted (spec §82).
 * Matched on the stable (season, week, bettor) coordinates of the source cell.
 */
export interface NamedCorrection {
  season: number;
  week: number;
  bettor: string;
  field: 'matchup' | 'outcome' | 'result';
  /** Value as it appears in the raw workbook; null means the source cell is blank. */
  originalValue: string | null;
  correctedValue: string;
  reason: string;
}

export const NAMED_CORRECTIONS: readonly NamedCorrection[] = [
  {
    season: 2025,
    week: 4,
    bettor: 'Tanner',
    field: 'matchup',
    originalValue: 'Bengals @ Broncos',
    correctedValue: 'Bears @ Raiders',
    reason:
      'Accepted historical correction: the wager is Caleb Williams Over 1.5 Pass TDs, a Chicago Bears quarterback. The 2025 Week 4 matchup is Bears @ Raiders; the "Bengals @ Broncos" label was a spreadsheet entry error.',
  },
  {
    season: 2024,
    week: 17,
    bettor: 'Dan',
    field: 'outcome',
    originalValue: null,
    correctedValue: '40-34',
    reason:
      'Accepted historical restoration: Lions @ 49ers finished Lions 40 - 49ers 34. Dan\'s Lions -3.5 wager is a WIN. The blank source cell must not re-empty this value on re-import.',
  },
  {
    season: 2025,
    week: 9,
    bettor: 'Austin',
    field: 'outcome',
    originalValue: null,
    correctedValue: '2 Pass TDs & Chargers Win',
    reason:
      'Accepted historical restoration: Justin Herbert threw 2 passing touchdowns and the Chargers won, so the "J. Herbert 2+ Pass TDs & Chargers Win" wager is a WIN. The blank source cell must not re-empty this value on re-import.',
  },
];

export function findNamedCorrections(season: number, week: number, bettor: string): NamedCorrection[] {
  return NAMED_CORRECTIONS.filter(
    (c) => c.season === season && c.week === week && c.bettor.toLowerCase() === bettor.toLowerCase(),
  );
}

/** The founding roster (spec §3). Editable by administrators for future seasons. */
export const INITIAL_ROSTER = [
  'Austin',
  'Carson',
  'Clayton',
  'Dan',
  'Hunter',
  'Jake',
  'Nick',
  'Tanner',
  'Taylon',
  'Trey',
] as const;
