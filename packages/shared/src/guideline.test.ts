import { describe, it, expect } from 'vitest';
import { checkGuideline, isWithinGuideline, assessMovement, DEFAULT_GUIDELINE } from './guideline.js';

describe('ACCEPTANCE (spec §30, §97): outside-guideline pick warns but stays selectable', () => {
  it('flags +225 as outside the preferred range and still allows it', () => {
    const w = checkGuideline(225);
    expect(w.outsideGuideline).toBe(true);
    expect(w.preferredRange).toBe('-200 to +200');
    expect(w.message).toContain('OUTSIDE GROUP ODDS GUIDELINE');
    expect(w.message).toContain('+225');
    // Nothing in the domain layer blocks the selection: the caller decides.
  });

  it('treats the boundaries themselves as inside', () => {
    expect(isWithinGuideline(-200)).toBe(true);
    expect(isWithinGuideline(200)).toBe(true);
    expect(isWithinGuideline(-201)).toBe(false);
    expect(isWithinGuideline(201)).toBe(false);
  });

  it('honors admin-configured boundaries', () => {
    const strict = { ...DEFAULT_GUIDELINE, minAmerican: -150, maxAmerican: 150 };
    expect(isWithinGuideline(-175, strict)).toBe(false);
    expect(isWithinGuideline(-175)).toBe(true);
  });
});

describe('ACCEPTANCE (spec §31, §97): -185 becomes -215 warns and never unlocks', () => {
  it('alerts because the price crossed the -200 boundary', () => {
    const m = assessMovement(-185, -215);
    expect(m.shouldAlert).toBe(true);
    expect(m.crossedIntoOutsideGuideline).toBe(true);
    expect(m.reasons).toContain('CROSSED_GUIDELINE_BOUNDARY');
    expect(m.message).toContain("outside the group's preferred odds range");
    // The assessment reports only. It carries no unlock/release instruction.
    expect(Object.keys(m)).not.toContain('unlock');
  });

  it('alerts on a 5-point implied-probability shift even inside the range', () => {
    // -150 (60.0%) -> -190 (65.5%) is a 5.5 point move, still inside -200..+200.
    const m = assessMovement(-150, -190);
    expect(m.impliedProbabilityPoints).toBeGreaterThan(5);
    expect(m.reasons).toContain('IMPLIED_PROBABILITY_SHIFT');
    expect(m.crossedIntoOutsideGuideline).toBe(false);
    expect(m.shouldAlert).toBe(true);
  });

  it('stays quiet for ordinary noise', () => {
    const m = assessMovement(-150, -155);
    expect(Math.abs(m.impliedProbabilityPoints)).toBeLessThan(5);
    expect(m.shouldAlert).toBe(false);
    expect(m.message).toBeNull();
  });

  it('uses implied probability, not raw American movement', () => {
    // +400 -> +420 is 20 American points but only ~0.8 probability points.
    const longshot = assessMovement(400, 420);
    expect(longshot.shouldAlert).toBe(false);
    // -110 -> -130 is 20 American points and ~4.1 probability points: still quiet,
    // but far closer to the threshold than the longshot move.
    const nearMoney = assessMovement(-110, -130);
    expect(Math.abs(nearMoney.impliedProbabilityPoints))
      .toBeGreaterThan(Math.abs(longshot.impliedProbabilityPoints));
  });
});
