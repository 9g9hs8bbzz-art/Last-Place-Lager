import type { LegResult } from './odds.js';

/**
 * Automatic grading (spec §62) and bad-beat data (spec §63).
 *
 * Every grade carries the underlying statistical outcome and the margin by
 * which it hit or missed, so "lost by one yard" stays in the record forever
 * rather than collapsing into a bare L.
 */

export type GradableMarket =
  | 'MONEYLINE'
  | 'SPREAD'
  | 'GAME_TOTAL'
  | 'TEAM_TOTAL'
  | 'PLAYER_OVER_UNDER'
  | 'PLAYER_THRESHOLD'
  | 'ANYTIME_TOUCHDOWN';

export type Side = 'OVER' | 'UNDER' | 'HOME' | 'AWAY' | 'YES' | 'NO';

export interface GradeInput {
  market: GradableMarket;
  side: Side;
  /** Spread, total or prop threshold. Null for moneyline / anytime-TD. */
  line: number | null;
  /**
   * The observed statistic: final margin for a spread, combined points for a
   * total, the player's yardage for a prop, touchdowns scored, etc.
   */
  actual: number | null;
}

export interface GradeOutput {
  result: LegResult;
  /**
   * Signed distance from the line in the direction of the bettor.
   * Positive = won by this much, negative = missed by this much, 0 = push.
   * Null when the market could not be graded automatically.
   */
  margin: number | null;
  /** Human-readable bad-beat / good-beat phrasing, e.g. "MISSED BY 1 YARD". */
  narrative: string | null;
  /** True when the app cannot grade this confidently and an admin must decide. */
  requiresManualGrading: boolean;
}

const AWAITING: GradeOutput = {
  result: 'PENDING',
  margin: null,
  narrative: null,
  requiresManualGrading: true,
};

/**
 * Grade one leg. Returns AWAITING MANUAL GRADING rather than guessing whenever
 * the inputs do not determine a result (spec §62).
 */
export function gradeLeg(input: GradeInput): GradeOutput {
  const { market, side, line, actual } = input;
  if (actual === null || !Number.isFinite(actual)) return AWAITING;

  switch (market) {
    case 'MONEYLINE': {
      // `actual` is the selected team's final margin: positive = they won.
      if (actual === 0) return { result: 'PUSH', margin: 0, narrative: 'TIE GAME', requiresManualGrading: false };
      return decide(actual, 'POINT');
    }

    case 'SPREAD': {
      if (line === null) return AWAITING;
      // `actual` is the selected team's final margin; the spread is added to it.
      return decide(actual + line, 'POINT');
    }

    case 'GAME_TOTAL':
    case 'TEAM_TOTAL': {
      if (line === null) return AWAITING;
      if (side !== 'OVER' && side !== 'UNDER') return AWAITING;
      const diff = side === 'OVER' ? actual - line : line - actual;
      return decide(diff, 'POINT');
    }

    case 'PLAYER_OVER_UNDER': {
      if (line === null) return AWAITING;
      if (side !== 'OVER' && side !== 'UNDER') return AWAITING;
      const diff = side === 'OVER' ? actual - line : line - actual;
      return decide(diff, 'UNIT');
    }

    case 'PLAYER_THRESHOLD': {
      // "25+ rushing yards" hits at exactly 25, so the boundary is inclusive.
      if (line === null) return AWAITING;
      return decide(actual - line, 'UNIT', true);
    }

    case 'ANYTIME_TOUCHDOWN': {
      return actual >= 1
        ? { result: 'WIN', margin: actual, narrative: `${actual} TOUCHDOWN${actual === 1 ? '' : 'S'}`, requiresManualGrading: false }
        : { result: 'LOSS', margin: -1, narrative: 'NO TOUCHDOWN', requiresManualGrading: false };
    }

    default:
      return AWAITING;
  }
}

function decide(diff: number, unit: 'POINT' | 'UNIT', inclusive = false): GradeOutput {
  const rounded = round2(diff);
  if (rounded === 0) {
    return inclusive
      ? { result: 'WIN', margin: 0, narrative: 'HIT EXACTLY ON THE NUMBER', requiresManualGrading: false }
      : { result: 'PUSH', margin: 0, narrative: 'PUSH — LANDED ON THE NUMBER', requiresManualGrading: false };
  }
  const noun = unit === 'POINT' ? 'POINT' : 'UNIT';
  const abs = Math.abs(rounded);
  const plural = abs === 1 ? '' : 'S';
  return rounded > 0
    ? { result: 'WIN', margin: rounded, narrative: `WON BY ${trim(abs)} ${noun}${plural}`, requiresManualGrading: false }
    : { result: 'LOSS', margin: rounded, narrative: `MISSED BY ${trim(abs)} ${noun}${plural}`, requiresManualGrading: false };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n);
}

/**
 * How much more the bettor still needs, for live leg progress (spec §60).
 * Returns null when the wager has no remaining requirement to express.
 */
export function remainingToHit(input: GradeInput): { needed: number; text: string } | null {
  const { market, side, line, actual } = input;
  if (line === null || actual === null) return null;

  if (market === 'PLAYER_THRESHOLD' || (market === 'PLAYER_OVER_UNDER' && side === 'OVER')) {
    const needed = round2(line - actual + (market === 'PLAYER_OVER_UNDER' ? 0.01 : 0));
    if (needed <= 0) return null;
    return { needed: round2(line - actual), text: `NEEDS ${trim(round2(line - actual))} MORE` };
  }

  if ((market === 'GAME_TOTAL' || market === 'TEAM_TOTAL') && side === 'OVER') {
    const needed = round2(line - actual);
    if (needed <= 0) return null;
    return { needed, text: `NEEDS ${trim(needed)} MORE TOTAL POINTS` };
  }

  if (market === 'SPREAD') {
    const cover = round2(actual + line);
    return cover >= 0
      ? { needed: 0, text: `CURRENTLY COVERING BY ${trim(cover)}` }
      : { needed: round2(-cover), text: `NEEDS ${trim(-cover)} MORE POINTS TO COVER` };
  }

  return null;
}
