/**
 * Weekday arithmetic in the group's own timezone (spec §6).
 *
 * Eligibility is "Sunday and Monday games", and that means Sunday and Monday as
 * the group experiences them in Montana — not in UTC. The distinction is not
 * academic: a Monday Night Football kickoff at 6:15 PM Mountain is already
 * Tuesday in UTC, so computing the weekday from UTC drops Monday night from the
 * board every week, and lets Sunday Night Football through only because its UTC
 * day happens to land on Monday.
 */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** The group's home timezone. Montana is Mountain Time. */
export const DEFAULT_TIME_ZONE = 'America/Denver';

/**
 * The day of the week (0 = Sunday … 6 = Saturday) that `date` falls on when
 * read in `timeZone`. Daylight saving is handled by the platform, so this stays
 * correct across the November change in the middle of the season.
 */
export function weekdayIn(date: Date, timeZone: string = DEFAULT_TIME_ZONE): number {
  const label = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
  const index = DAY_NAMES.indexOf(label as (typeof DAY_NAMES)[number]);
  if (index === -1) {
    // An unknown timezone would otherwise silently mark every game ineligible.
    throw new Error(`Could not read a weekday for time zone "${timeZone}"`);
  }
  return index;
}

/** Short weekday label in `timeZone`, for display: "Sun", "Mon", … */
export function weekdayLabelIn(date: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  return DAY_NAMES[weekdayIn(date, timeZone)];
}
