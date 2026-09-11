import { type AmericanOdds, impliedProbability, formatAmerican } from './odds.js';

/**
 * The group's preferred price range (spec §30). This is a GUIDELINE, never a
 * restriction: every function here reports, and nothing here blocks a pick.
 */
export interface OddsGuideline {
  minAmerican: number; // default -200
  maxAmerican: number; // default +200
  /** Alert when implied probability moves by at least this much, in percentage points (spec §31). */
  movementPointsThreshold: number; // default 5
}

export const DEFAULT_GUIDELINE: OddsGuideline = {
  minAmerican: -200,
  maxAmerican: 200,
  movementPointsThreshold: 5,
};

/**
 * A price is inside the guideline when it sits between the two boundaries on the
 * American number line, where -200 .. -100 .. +100 .. +200 is ascending.
 * Ordering American odds directly works here because both boundaries are
 * conventional "round" prices on opposite sides of even money.
 */
export function isWithinGuideline(odds: AmericanOdds, g: OddsGuideline = DEFAULT_GUIDELINE): boolean {
  return odds >= g.minAmerican && odds <= g.maxAmerican;
}

export interface GuidelineWarning {
  outsideGuideline: boolean;
  currentOdds: AmericanOdds;
  preferredRange: string;
  message: string | null;
}

export function checkGuideline(odds: AmericanOdds, g: OddsGuideline = DEFAULT_GUIDELINE): GuidelineWarning {
  const within = isWithinGuideline(odds, g);
  const preferredRange = `${formatAmerican(g.minAmerican)} to ${formatAmerican(g.maxAmerican)}`;
  return {
    outsideGuideline: !within,
    currentOdds: odds,
    preferredRange,
    message: within
      ? null
      : `OUTSIDE GROUP ODDS GUIDELINE — Current Odds: ${formatAmerican(odds)}, Preferred Range: ${preferredRange}`,
  };
}

export type MovementAlertReason = 'IMPLIED_PROBABILITY_SHIFT' | 'CROSSED_GUIDELINE_BOUNDARY';

export interface MovementAssessment {
  lockedOdds: AmericanOdds;
  currentOdds: AmericanOdds;
  /** Signed change in implied probability, in percentage points. Positive = shorter price. */
  impliedProbabilityPoints: number;
  shouldAlert: boolean;
  reasons: MovementAlertReason[];
  crossedIntoOutsideGuideline: boolean;
  message: string | null;
}

/**
 * Decide whether locked-price movement is worth interrupting a member for
 * (spec §31). Implied probability is the measure, not raw American movement:
 * -110 -> -130 is a bigger real move than +400 -> +420 despite the smaller
 * American delta. A pick that crosses a guideline boundary always alerts.
 *
 * This function never unlocks, never edits the wager and never releases the
 * matchup — it only reports.
 */
export function assessMovement(
  lockedOdds: AmericanOdds,
  currentOdds: AmericanOdds,
  g: OddsGuideline = DEFAULT_GUIDELINE,
): MovementAssessment {
  const points = (impliedProbability(currentOdds) - impliedProbability(lockedOdds)) * 100;
  const reasons: MovementAlertReason[] = [];

  if (Math.abs(points) >= g.movementPointsThreshold) reasons.push('IMPLIED_PROBABILITY_SHIFT');

  const wasWithin = isWithinGuideline(lockedOdds, g);
  const isWithin = isWithinGuideline(currentOdds, g);
  if (wasWithin !== isWithin) reasons.push('CROSSED_GUIDELINE_BOUNDARY');

  const crossedOut = wasWithin && !isWithin;
  let message: string | null = null;
  if (crossedOut) {
    message = `Your locked wager has moved outside the group's preferred odds range (${formatAmerican(lockedOdds)} → ${formatAmerican(currentOdds)}).`;
  } else if (reasons.length > 0) {
    message = `Your locked wager moved from ${formatAmerican(lockedOdds)} to ${formatAmerican(currentOdds)}.`;
  }

  return {
    lockedOdds,
    currentOdds,
    impliedProbabilityPoints: points,
    shouldAlert: reasons.length > 0,
    reasons,
    crossedIntoOutsideGuideline: crossedOut,
    message,
  };
}
