import { describe, it, expect } from 'vitest';
import { gradeLeg, remainingToHit } from './grading.js';

describe('automatic grading (spec §62)', () => {
  it('grades a moneyline by final margin', () => {
    expect(gradeLeg({ market: 'MONEYLINE', side: 'HOME', line: null, actual: 7 }).result).toBe('WIN');
    expect(gradeLeg({ market: 'MONEYLINE', side: 'HOME', line: null, actual: -3 }).result).toBe('LOSS');
    expect(gradeLeg({ market: 'MONEYLINE', side: 'HOME', line: null, actual: 0 }).result).toBe('PUSH');
  });

  it('grades a spread against the number', () => {
    // Broncos -3.5, won by 3 -> loss by half a point (spec §63 example).
    const g = gradeLeg({ market: 'SPREAD', side: 'HOME', line: -3.5, actual: 3 });
    expect(g.result).toBe('LOSS');
    expect(g.margin).toBeCloseTo(-0.5, 9);
    expect(g.narrative).toBe('MISSED BY 0.5 POINTS');
  });

  it('pushes a whole-number spread landing exactly on the number', () => {
    const g = gradeLeg({ market: 'SPREAD', side: 'AWAY', line: -3, actual: 3 });
    expect(g.result).toBe('PUSH');
    expect(g.margin).toBe(0);
  });

  it('grades totals both ways', () => {
    expect(gradeLeg({ market: 'GAME_TOTAL', side: 'OVER', line: 48.5, actual: 52 }).result).toBe('WIN');
    expect(gradeLeg({ market: 'GAME_TOTAL', side: 'UNDER', line: 48.5, actual: 52 }).result).toBe('LOSS');
  });

  it('treats a "25+" threshold as inclusive of the number', () => {
    expect(gradeLeg({ market: 'PLAYER_THRESHOLD', side: 'YES', line: 25, actual: 25 }).result).toBe('WIN');
    expect(gradeLeg({ market: 'PLAYER_THRESHOLD', side: 'YES', line: 25, actual: 24 }).result).toBe('LOSS');
  });

  it('records bad-beat detail (spec §63)', () => {
    // Justin Jefferson 75+, finished with 74.
    const g = gradeLeg({ market: 'PLAYER_THRESHOLD', side: 'YES', line: 75, actual: 74 });
    expect(g.result).toBe('LOSS');
    expect(g.margin).toBe(-1);
    expect(g.narrative).toBe('MISSED BY 1 UNIT');
  });

  it('grades anytime touchdown', () => {
    expect(gradeLeg({ market: 'ANYTIME_TOUCHDOWN', side: 'YES', line: null, actual: 2 }).result).toBe('WIN');
    expect(gradeLeg({ market: 'ANYTIME_TOUCHDOWN', side: 'YES', line: null, actual: 0 }).result).toBe('LOSS');
  });

  it('AWAITS MANUAL GRADING instead of guessing when the stat is missing', () => {
    const g = gradeLeg({ market: 'PLAYER_THRESHOLD', side: 'YES', line: 25, actual: null });
    expect(g.requiresManualGrading).toBe(true);
    expect(g.result).toBe('PENDING');
    expect(g.margin).toBeNull();
  });

  it('AWAITS MANUAL GRADING when a lined market has no line', () => {
    expect(gradeLeg({ market: 'SPREAD', side: 'HOME', line: null, actual: 7 }).requiresManualGrading).toBe(true);
  });
});

describe('live leg progress (spec §60)', () => {
  it('says how many more units are needed', () => {
    const r = remainingToHit({ market: 'PLAYER_THRESHOLD', side: 'YES', line: 225, actual: 198 });
    expect(r!.needed).toBe(27);
    expect(r!.text).toBe('NEEDS 27 MORE');
  });
  it('says how much a spread is currently covering by', () => {
    const r = remainingToHit({ market: 'SPREAD', side: 'HOME', line: -3.5, actual: 8 });
    expect(r!.text).toBe('CURRENTLY COVERING BY 4.5');
  });
  it('says how many more total points an over needs', () => {
    const r = remainingToHit({ market: 'GAME_TOTAL', side: 'OVER', line: 48.5, actual: 41.5 });
    expect(r!.text).toBe('NEEDS 7 MORE TOTAL POINTS');
  });
  it('returns null once the threshold is already met', () => {
    expect(remainingToHit({ market: 'PLAYER_THRESHOLD', side: 'YES', line: 25, actual: 32 })).toBeNull();
  });
});
