import { describe, it, expect } from 'vitest';
import { weekdayIn, weekdayLabelIn, DEFAULT_TIME_ZONE } from './time.js';

/**
 * These are real 2026 week 1 kickoffs as ESPN reports them, in UTC. The point of
 * every case is the same: the weekday the group experiences is not always the
 * weekday UTC reports.
 */
describe('what day is it where the group is', () => {
  it('reads a Sunday afternoon game as Sunday', () => {
    expect(weekdayLabelIn(new Date('2026-09-13T17:00Z'))).toBe('Sun');
  });

  it('reads Sunday Night Football as Sunday, not Monday', () => {
    // 6:20 PM Mountain on Sunday, which is already Monday in UTC.
    const snf = new Date('2026-09-14T00:20Z');
    expect(snf.getUTCDay()).toBe(1);
    expect(weekdayIn(snf)).toBe(0);
  });

  it('reads Monday Night Football as Monday, not Tuesday', () => {
    // This is the case that used to drop off the board every week.
    const mnf = new Date('2026-09-15T00:15Z');
    expect(mnf.getUTCDay()).toBe(2);
    expect(weekdayIn(mnf)).toBe(1);
  });

  it('stays correct after the November daylight saving change', () => {
    // Mountain is UTC-6 in September and UTC-7 in November; a Monday night
    // kickoff must still read as Monday on both sides of the change.
    expect(weekdayIn(new Date('2026-11-17T01:15Z'))).toBe(1);
    expect(weekdayIn(new Date('2026-09-15T00:15Z'))).toBe(1);
  });

  it('defaults to Montana', () => {
    expect(DEFAULT_TIME_ZONE).toBe('America/Denver');
    expect(weekdayIn(new Date('2026-09-15T00:15Z'), 'America/Denver')).toBe(
      weekdayIn(new Date('2026-09-15T00:15Z')),
    );
  });

  it('honours a different timezone when one is given', () => {
    // The same instant is already Tuesday in London.
    expect(weekdayIn(new Date('2026-09-15T00:15Z'), 'Europe/London')).toBe(2);
  });

  it('refuses an unusable timezone rather than marking everything ineligible', () => {
    expect(() => weekdayIn(new Date(), 'Not/AZone')).toThrow();
  });
});
