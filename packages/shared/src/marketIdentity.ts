/**
 * Stable market identity (spec §28).
 *
 * "Josh Allen | Rushing Yards | 25+ | -175" and the same selection later priced
 * at -205 are the SAME underlying selection with different pricing. But 25+ and
 * 30+ are DIFFERENT selections and must never be silently interchanged.
 *
 * The selection key therefore includes everything that defines *what* is being
 * wagered, and deliberately excludes the price.
 */

export type MarketCategory =
  | 'GAME_LINE'
  | 'TEAM_TOTAL'
  | 'PLAYER_PROP'
  | 'GAME_PROP'
  | 'TOUCHDOWN_SCORER'
  | 'KICKING'
  | 'OTHER';

export interface SelectionIdentity {
  /** Sportsbook event identifier this selection belongs to. */
  sourceEventId: string;
  category: MarketCategory;
  /** Normalized market name, e.g. "RUSHING_YARDS", "SPREAD", "MONEYLINE". */
  marketKey: string;
  /** Player or team the selection is about, normalized. Null for pure game markets. */
  subjectKey: string | null;
  /** Which side, e.g. "OVER", "UNDER", "HOME", "AWAY", "YES". */
  selectionKey: string;
  /**
   * The number that defines the selection: a threshold (25 for "25+"),
   * a spread (-3.5), or a total (48.5). Null when the market has no line.
   * Changing this produces a DIFFERENT selection, never a repriced one.
   */
  line: number | null;
}

/** Normalize free text into a stable key: uppercase, alphanumerics and underscores. */
export function normalizeKey(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

/**
 * Build the identity string used as the database key for a selection.
 * Price is intentionally absent.
 */
export function selectionKeyOf(identity: SelectionIdentity): string {
  const line = identity.line === null ? 'NONE' : formatLine(identity.line);
  return [
    identity.sourceEventId,
    identity.category,
    normalizeKey(identity.marketKey),
    normalizeKey(identity.subjectKey) || 'NONE',
    normalizeKey(identity.selectionKey),
    line,
  ].join('|');
}

/** Stable textual form of a line so 25 and 25.0 never split into two selections. */
export function formatLine(line: number): string {
  return Number.isInteger(line) ? line.toFixed(1) : String(line);
}

/** Two selections are the same wager if and only if their identity keys match. */
export function isSameSelection(a: SelectionIdentity, b: SelectionIdentity): boolean {
  return selectionKeyOf(a) === selectionKeyOf(b);
}

/**
 * Whether a stored snapshot needs a new history row (spec §29).
 * Identical state only bumps "last verified"; a real change is archived.
 */
export function isMeaningfulChange(
  previous: { americanOdds: number | null; available: boolean; line: number | null },
  next: { americanOdds: number | null; available: boolean; line: number | null },
): boolean {
  return (
    previous.americanOdds !== next.americanOdds ||
    previous.available !== next.available ||
    previous.line !== next.line
  );
}
