import { describe, it, expect } from 'vitest';
import {
  americanToDecimal, decimalToAmerican, impliedProbability, averageAmericanOdds,
  combineParlayOdds, hypotheticalProfit, formatAmerican, parseAmerican, OddsError,
} from './odds.js';

describe('American <-> decimal conversion', () => {
  it('converts negative prices', () => {
    expect(americanToDecimal(-175)).toBeCloseTo(1.5714285714, 9);
    expect(americanToDecimal(-110)).toBeCloseTo(1.9090909091, 9);
  });
  it('converts positive prices', () => {
    expect(americanToDecimal(150)).toBeCloseTo(2.5, 9);
    expect(americanToDecimal(100)).toBeCloseTo(2.0, 9);
  });
  it('round-trips', () => {
    for (const o of [-500, -205, -175, -110, 100, 115, 190, 225, 900]) {
      expect(decimalToAmerican(americanToDecimal(o))).toBeCloseTo(o, 6);
    }
  });
  it('canonicalizes even money to +100', () => {
    // -100 and +100 are the same price (decimal 2.0); the app stores one form.
    expect(americanToDecimal(-100)).toBe(2);
    expect(decimalToAmerican(2)).toBe(100);
  });
  it('rejects impossible American prices', () => {
    expect(() => americanToDecimal(-50)).toThrow(OddsError);
    expect(() => americanToDecimal(0)).toThrow(OddsError);
    expect(() => americanToDecimal(99)).toThrow(OddsError);
  });
});

describe('implied probability', () => {
  it('is the break-even win rate', () => {
    expect(impliedProbability(-200)).toBeCloseTo(2 / 3, 9);
    expect(impliedProbability(100)).toBeCloseTo(0.5, 9);
    expect(impliedProbability(200)).toBeCloseTo(1 / 3, 9);
  });
});

describe('ACCEPTANCE (spec §65, §97): average odds via averaged decimal odds', () => {
  it('averages decimals then converts back, NOT raw American', () => {
    // -110 and +110: decimals 1.909090... and 2.10 -> mean 2.004545... -> +0.45
    const result = averageAmericanOdds([-110, 110])!;
    const naive = (-110 + 110) / 2; // the wrong method would give 0, an impossible price
    expect(naive).toBe(0);
    expect(result).toBeCloseTo(100.4545454545, 6);
    expect(result).toBeGreaterThan(100);
  });

  it('matches the spreadsheet methodology on a real historical week', () => {
    // 2025 Week 1 prices straight from the workbook.
    const week1 = [-159, -167, -109, -115, 118, 115, -118, -167, -115, -135];
    const meanDecimal = week1.reduce((s, o) => s + americanToDecimal(o), 0) / week1.length;
    expect(averageAmericanOdds(week1)!).toBeCloseTo(decimalToAmerican(meanDecimal), 9);
    // Sanity: the workbook's own cumulative average for that week is about -122.
    expect(averageAmericanOdds(week1)!).toBeLessThan(-100);
  });

  it('returns null for an empty sample rather than a misleading zero', () => {
    expect(averageAmericanOdds([])).toBeNull();
  });
});

describe('parlay odds', () => {
  it('multiplies decimal legs', () => {
    expect(combineParlayOdds([100, 100])).toBeCloseTo(300, 6); // 2.0 * 2.0 = 4.0 -> +300
  });
  it('produces a large price for a ten-leg parlay', () => {
    const legs = [-159, -167, -109, -115, 118, 115, -118, -167, -115, -135];
    const combined = combineParlayOdds(legs)!;
    // The workbook records 41962.66 for this exact week.
    expect(combined).toBeCloseTo(41962.6646, 2);
  });
});

describe('hypothetical $10 performance (spec §66)', () => {
  it('counts pushes and voids as stake returned', () => {
    const r = hypotheticalProfit([
      { odds: 100, result: 'WIN' },
      { odds: -110, result: 'LOSS' },
      { odds: -110, result: 'PUSH' },
      { odds: -110, result: 'VOID' },
    ]);
    expect(r.wagered).toBe(40);
    expect(r.profit).toBeCloseTo(0, 9); // +10 win, -10 loss, 0, 0
    expect(r.roi).toBeCloseTo(0, 9);
  });
  it('ignores pending picks entirely', () => {
    const r = hypotheticalProfit([{ odds: -110, result: 'PENDING' }]);
    expect(r.wagered).toBe(0);
    expect(r.roi).toBeNull();
  });
  it('matches the workbook for a single -159 winner', () => {
    const r = hypotheticalProfit([{ odds: -159, result: 'WIN' }]);
    expect(r.profit).toBeCloseTo(6.289308176, 6); // workbook: 6.289308176
  });
});

describe('formatting and parsing', () => {
  it('always signs the price', () => {
    expect(formatAmerican(120)).toBe('+120');
    expect(formatAmerican(-175)).toBe('-175');
    expect(formatAmerican(null)).toBe('—');
  });
  it('parses free text without guessing', () => {
    expect(parseAmerican('-175')).toBe(-175);
    expect(parseAmerican('+120')).toBe(120);
    expect(parseAmerican('EVEN')).toBe(100);
    expect(parseAmerican('abc')).toBeNull();
    expect(parseAmerican('-50')).toBeNull(); // impossible price -> null, not a guess
  });
});
