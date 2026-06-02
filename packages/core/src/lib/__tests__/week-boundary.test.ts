import { describe, it, expect } from "vitest";
import {
  currentWeekStart,
  weekEndFor,
  weekIdFromStart,
  formatWeekHeading,
  toIsoDate,
} from "../week-boundary";

function d(year: number, monthIndex0: number, day: number, hour = 12, minute = 0): Date {
  // Construct a local-time Date. monthIndex0: Jan = 0.
  return new Date(year, monthIndex0, day, hour, minute, 0, 0);
}

describe("currentWeekStart", () => {
  it("returns the same Sunday when today is Sunday at noon", () => {
    const sun = d(2026, 4, 10); // May 10 2026 is a Sunday
    const ws = currentWeekStart(sun);
    expect(toIsoDate(ws)).toBe("2026-05-10");
  });

  it("returns previous Sunday when today is Tuesday", () => {
    const tue = d(2026, 4, 12); // Tue
    const ws = currentWeekStart(tue);
    expect(toIsoDate(ws)).toBe("2026-05-10");
  });

  it("returns previous Sunday when today is Saturday", () => {
    const sat = d(2026, 4, 16); // Sat
    const ws = currentWeekStart(sat);
    expect(toIsoDate(ws)).toBe("2026-05-10");
  });

  it("at Sunday 00:00:00 returns the NEW week (current, 0 seconds in)", () => {
    const sunMidnight = new Date(2026, 4, 17, 0, 0, 0, 0); // May 17 2026, 00:00
    const ws = currentWeekStart(sunMidnight);
    expect(toIsoDate(ws)).toBe("2026-05-17");
  });

  it("crosses a year boundary cleanly", () => {
    const newYearsDay = d(2026, 0, 1); // Thu Jan 1 2026
    const ws = currentWeekStart(newYearsDay);
    // Previous Sunday is Dec 28 2025.
    expect(toIsoDate(ws)).toBe("2025-12-28");
  });

  it("handles US spring DST transition", () => {
    // Spring forward 2026 is Sun Mar 8. Week starts that Sunday.
    const dstSunday = d(2026, 2, 8, 12); // noon to avoid the 2-3am gap
    const ws = currentWeekStart(dstSunday);
    expect(toIsoDate(ws)).toBe("2026-03-08");

    const dstThursday = d(2026, 2, 12); // Thu Mar 12, still in same DST week
    expect(toIsoDate(currentWeekStart(dstThursday))).toBe("2026-03-08");
  });
});

describe("weekEndFor", () => {
  it("clamps to today when today is mid-week", () => {
    const ws = d(2026, 4, 10); // Sun May 10
    const today = d(2026, 4, 12); // Tue May 12
    expect(toIsoDate(weekEndFor(ws, today))).toBe("2026-05-12");
  });

  it("returns the nominal Saturday when today is past the end", () => {
    const ws = d(2026, 4, 10); // Sun May 10
    const today = d(2026, 4, 20); // Wed May 20 (next week)
    expect(toIsoDate(weekEndFor(ws, today))).toBe("2026-05-16");
  });

  it("equals weekStart when today is Sunday", () => {
    const ws = d(2026, 4, 10); // Sun May 10
    const today = d(2026, 4, 10, 15); // same Sunday, afternoon
    expect(toIsoDate(weekEndFor(ws, today))).toBe("2026-05-10");
  });
});

describe("weekIdFromStart", () => {
  it("returns YYYY-MM-DD of the Sunday", () => {
    expect(weekIdFromStart(d(2026, 4, 10))).toBe("2026-05-10");
  });

  it("handles single-digit month/day with zero padding", () => {
    expect(weekIdFromStart(d(2026, 0, 4))).toBe("2026-01-04");
  });
});

describe("formatWeekHeading", () => {
  it("formats a same-month range", () => {
    const ws = d(2026, 4, 10);
    const we = d(2026, 4, 16);
    expect(formatWeekHeading(ws, we)).toBe("Week of May 10–16, 2026");
  });

  it("formats a cross-month range", () => {
    const ws = d(2026, 5, 28); // June 28
    const we = d(2026, 6, 4);  // July 4
    expect(formatWeekHeading(ws, we)).toBe("Week of June 28–July 4, 2026");
  });

  it("formats a cross-year range using the start year", () => {
    const ws = d(2025, 11, 28); // Dec 28 2025
    const we = d(2026, 0, 3);   // Jan 3 2026
    expect(formatWeekHeading(ws, we)).toBe("Week of December 28, 2025–January 3, 2026");
  });

  it("formats a single-day partial week (today is Sunday)", () => {
    const sun = d(2026, 4, 10);
    expect(formatWeekHeading(sun, sun)).toBe("Week of May 10, 2026");
  });
});

describe("toIsoDate", () => {
  it("returns YYYY-MM-DD in local time", () => {
    expect(toIsoDate(d(2026, 4, 10, 23, 59))).toBe("2026-05-10");
    expect(toIsoDate(d(2026, 0, 1, 0))).toBe("2026-01-01");
  });
});
