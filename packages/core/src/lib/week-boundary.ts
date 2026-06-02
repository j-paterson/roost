/**
 * Sunday-start week math in LOCAL time. Used by the weekly digest pipeline
 * to map "now" to a week-start anchor and emit the output filename.
 *
 * All inputs/outputs are JS Date objects (treated as local time) or
 * `YYYY-MM-DD` strings (always local-time interpretation).
 */

/** Format a Date as `YYYY-MM-DD` using its local-time year/month/day. */
export function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Returns a Date at 00:00:00 local time on the Sunday that begins `today`'s
 * week. Sunday returns Sunday (the current week's Sunday). Sunday at 00:00
 * still returns Sunday (the new week, 0 seconds in).
 */
export function currentWeekStart(today: Date): Date {
  // getDay(): 0 = Sun, 1 = Mon, ... 6 = Sat
  const dayOfWeek = today.getDay();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0);
  start.setDate(start.getDate() - dayOfWeek);
  return start;
}

/**
 * Returns a Date for the last day of this week's coverage:
 * - weekStart + 6 days if today is past Saturday
 * - today (truncated to local midnight) if today is between weekStart and Saturday
 */
export function weekEndFor(weekStart: Date, today: Date): Date {
  const nominal = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate());
  nominal.setDate(nominal.getDate() + 6);
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return todayMidnight < nominal ? todayMidnight : nominal;
}

/** Week id is the Sunday-start date as YYYY-MM-DD. Used as the filename
 *  stem and the cache key. */
export function weekIdFromStart(weekStart: Date): string {
  return toIsoDate(weekStart);
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** Human-readable heading.
 *
 *   Sun May 10 → Sat May 16, 2026     → "Week of May 10–16, 2026"
 *   Sun Jun 28 → Sat Jul 4, 2026      → "Week of June 28–July 4, 2026"
 *   Sun Dec 28 2025 → Sat Jan 3 2026  → "Week of December 28, 2025–January 3, 2026"
 *   Sun May 10 → Sun May 10 (partial) → "Week of May 10, 2026"
 */
export function formatWeekHeading(weekStart: Date, weekEnd: Date): string {
  const startMonth = MONTHS[weekStart.getMonth()];
  const startDay = weekStart.getDate();
  const startYear = weekStart.getFullYear();
  const endMonth = MONTHS[weekEnd.getMonth()];
  const endDay = weekEnd.getDate();
  const endYear = weekEnd.getFullYear();

  // Single-day partial: same Sunday for start and end.
  if (
    weekStart.getFullYear() === weekEnd.getFullYear() &&
    weekStart.getMonth() === weekEnd.getMonth() &&
    weekStart.getDate() === weekEnd.getDate()
  ) {
    return `Week of ${startMonth} ${startDay}, ${startYear}`;
  }

  // Cross-year: include both years.
  if (startYear !== endYear) {
    return `Week of ${startMonth} ${startDay}, ${startYear}–${endMonth} ${endDay}, ${endYear}`;
  }

  // Cross-month, same year: spell out both months.
  if (weekStart.getMonth() !== weekEnd.getMonth()) {
    return `Week of ${startMonth} ${startDay}–${endMonth} ${endDay}, ${startYear}`;
  }

  // Same month, same year: compact.
  return `Week of ${startMonth} ${startDay}–${endDay}, ${startYear}`;
}
