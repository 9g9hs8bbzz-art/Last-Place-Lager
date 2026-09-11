/**
 * Odds mathematics for First Class Parlays.
 *
 * The group's historical spreadsheet established one non-obvious rule that the
 * app must reproduce everywhere "Average Odds" is shown (spec §65):
 * average the DECIMAL odds, then convert the average back to American. Raw
 * American odds must never be averaged directly, because -110 and +110 are not
 * symmetric around zero in probability space.
 */

/** A positive or negative American (moneyline) price, e.g. -175 or +120. */
export type AmericanOdds = number;

export class OddsError extends Error {}

/** American prices between -100 and +100 (exclusive) do not exist. */
export function assertValidAmerican(odds: AmericanOdds): void {
  if (!Number.isFinite(odds)) throw new OddsError(`American odds must be a finite number, got ${odds}`);
  if (odds > -100 && odds < 100) {
    throw new OddsError(`American odds must be <= -100 or >= +100, got ${odds}`);
  }
}

/** -175 -> 1.5714..., +150 -> 2.5 */
export function americanToDecimal(odds: AmericanOdds): number {
  assertValidAmerican(odds);
  return odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds);
}

/** 1.5714... -> -175, 2.5 -> +150. Decimal 2.0 is conventionally +100. */
export function decimalToAmerican(decimal: number): AmericanOdds {
  if (!Number.isFinite(decimal) || decimal <= 1) {
    throw new OddsError(`Decimal odds must be > 1, got ${decimal}`);
  }
  return decimal >= 2 ? (decimal - 1) * 100 : -100 / (decimal - 1);
}

/** Break-even (vig-inclusive) win probability implied by a price, as 0..1. */
export function impliedProbability(odds: AmericanOdds): number {
  assertValidAmerican(odds);
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

/**
 * Average odds, spreadsheet-canonical (spec §65).
 * Convert each American price to decimal, average the decimals, convert back.
 * Returns null for an empty sample rather than 0, so callers never render a
 * meaningless "0" average.
 */
export function averageAmericanOdds(odds: readonly AmericanOdds[]): AmericanOdds | null {
  if (odds.length === 0) return null;
  const meanDecimal = odds.reduce((sum, o) => sum + americanToDecimal(o), 0) / odds.length;
  return decimalToAmerican(meanDecimal);
}

/** Parlay price: multiply the decimal legs, convert the product back. */
export function combineParlayOdds(legs: readonly AmericanOdds[]): AmericanOdds | null {
  if (legs.length === 0) return null;
  const product = legs.reduce((acc, o) => acc * americanToDecimal(o), 1);
  return decimalToAmerican(product);
}

/** Profit (not total return) on a winning stake. */
export function profitOnWin(stake: number, odds: AmericanOdds): number {
  return stake * (americanToDecimal(odds) - 1);
}

export type LegResult = 'WIN' | 'LOSS' | 'PUSH' | 'VOID' | 'PENDING';

/**
 * Hypothetical $10-per-pick performance (spec §66). Pushes and voids return the
 * stake and count as neither profit nor loss; pending picks are not yet staked.
 */
export function hypotheticalProfit(
  picks: readonly { odds: AmericanOdds; result: LegResult }[],
  stake = 10,
): { wagered: number; returned: number; profit: number; roi: number | null } {
  let wagered = 0;
  let returned = 0;
  for (const p of picks) {
    if (p.result === 'PENDING') continue;
    wagered += stake;
    if (p.result === 'WIN') returned += stake + profitOnWin(stake, p.odds);
    else if (p.result === 'PUSH' || p.result === 'VOID') returned += stake;
  }
  return { wagered, returned, profit: returned - wagered, roi: wagered === 0 ? null : (returned - wagered) / wagered };
}

/** Format for display: always signed, never "+-110". */
export function formatAmerican(odds: AmericanOdds | null | undefined): string {
  if (odds === null || odds === undefined || !Number.isFinite(odds)) return '—';
  const rounded = Math.round(odds);
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

/**
 * Parse an American price out of free text ("-175", "+120", "EVEN", "PK").
 * Returns null rather than guessing, so callers can flag it for human review.
 */
export function parseAmerican(raw: string | number | null | undefined): AmericanOdds | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const text = raw.trim().toUpperCase();
  if (text === '') return null;
  if (text === 'EVEN' || text === 'EV' || text === 'PK' || text === 'PICK') return 100;
  const match = text.match(/^([+-]?)(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const value = Number(match[2]);
  const signed = match[1] === '-' ? -value : value;
  try {
    assertValidAmerican(signed);
  } catch {
    return null;
  }
  return signed;
}
