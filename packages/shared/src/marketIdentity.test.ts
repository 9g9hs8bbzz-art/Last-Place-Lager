import { describe, it, expect } from 'vitest';
import { selectionKeyOf, isSameSelection, isMeaningfulChange, normalizeKey, type SelectionIdentity } from './marketIdentity.js';

const allen = (line: number): SelectionIdentity => ({
  sourceEventId: 'SBM-EVT-1', category: 'PLAYER_PROP', marketKey: 'Rushing Yards',
  subjectKey: 'Josh Allen', selectionKey: 'OVER', line,
});

describe('ACCEPTANCE (spec §28): stable market identity', () => {
  it('treats a reprice as the SAME selection', () => {
    // Josh Allen | Rushing Yards | 25+ at -175, later -205.
    expect(isSameSelection(allen(25), allen(25))).toBe(true);
    // Price is deliberately absent from the identity key.
    expect(selectionKeyOf(allen(25))).not.toContain('175');
  });

  it('treats a different threshold as a DIFFERENT selection', () => {
    expect(isSameSelection(allen(25), allen(30))).toBe(false);
  });

  it('does not split 25 and 25.0 into two selections', () => {
    expect(selectionKeyOf(allen(25))).toBe(selectionKeyOf(allen(25.0)));
  });

  it('normalizes punctuation and casing in names', () => {
    expect(normalizeKey("Ja'Marr Chase")).toBe('JA_MARR_CHASE');
    expect(normalizeKey('Rushing Yards')).toBe('RUSHING_YARDS');
  });
});

describe('market history (spec §29)', () => {
  const base = { americanOdds: -175, available: true, line: 25 };
  it('does not archive an identical snapshot', () => {
    expect(isMeaningfulChange(base, { ...base })).toBe(false);
  });
  it('archives a price change', () => {
    expect(isMeaningfulChange(base, { ...base, americanOdds: -195 })).toBe(true);
  });
  it('archives an availability change', () => {
    expect(isMeaningfulChange(base, { ...base, available: false })).toBe(true);
  });
  it('archives a line change', () => {
    expect(isMeaningfulChange(base, { ...base, line: 30 })).toBe(true);
  });
});
