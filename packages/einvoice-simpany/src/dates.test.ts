import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIST_MAX_SPAN_MONTHS,
  assertIsoDate,
  currentRocYear,
  defaultListWindow,
  exceedsMonthSpan,
  isIsoDate,
  shiftDate,
  simpanyListWindows,
  taipeiToday,
} from "./dates.js";

afterEach(() => {
  vi.useRealTimers();
});

/** Freeze the clock at an instant and run `fn`. */
function at<T>(instant: string, fn: () => T): T {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(instant));
    return fn();
  } finally {
    vi.useRealTimers();
  }
}

describe("isIsoDate", () => {
  it.each(["2026-08-07", "2028-02-29", "2026-01-01", "2026-12-31"])("accepts %s", (v) => {
    expect(isIsoDate(v)).toBe(true);
  });

  it.each([
    ["2026-02-30", "a day that does not exist"],
    ["2026-13-01", "a month that does not exist"],
    ["2027-02-29", "29 February in a non-leap year"],
    ["2026-8-07", "an unpadded month"],
    ["2026/08/07", "slashes"],
    ["", "an empty string"],
  ])("rejects %s (%s)", (v) => {
    expect(isIsoDate(v)).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isIsoDate(undefined)).toBe(false);
    expect(isIsoDate(20260807)).toBe(false);
  });
});

describe("assertIsoDate", () => {
  it("throws VALIDATION naming the field and the offending value", () => {
    expect(() => assertIsoDate("2026/08/07", "startDate")).toThrowError(
      /startDate must be a YYYY-MM-DD calendar date in Asia\/Taipei, got "2026\/08\/07"/,
    );
    try {
      assertIsoDate("x", "endDate");
    } catch (e) {
      expect(e).toMatchObject({ code: "VALIDATION", provider: "simpany" });
    }
  });

  it("passes a valid date through", () => {
    expect(() => assertIsoDate("2026-08-07", "startDate")).not.toThrow();
  });
});

describe("shiftDate", () => {
  it("shifts by whole months", () => {
    expect(shiftDate("2026-08-07", { months: -12 })).toBe("2025-08-07");
    expect(shiftDate("2026-08-07", { months: 12 })).toBe("2027-08-07");
    expect(shiftDate("2026-01-15", { months: -1 })).toBe("2025-12-15");
  });

  it("shifts by days, rolling over month and year ends", () => {
    expect(shiftDate("2026-08-31", { days: 1 })).toBe("2026-09-01");
    expect(shiftDate("2026-12-31", { days: 1 })).toBe("2027-01-01");
    expect(shiftDate("2026-01-01", { days: -1 })).toBe("2025-12-31");
  });

  it("applies months before days", () => {
    expect(shiftDate("2026-08-07", { months: -12, days: 1 })).toBe("2025-08-08");
  });

  // Overflow, not clamping — the server's date library behaves the same way, so
  // both ends agree on where a window boundary falls.
  it("overflows rather than clamping a short target month", () => {
    expect(shiftDate("2026-03-31", { months: -1 })).toBe("2026-03-03");
    expect(shiftDate("2028-02-29", { months: -12 })).toBe("2027-03-01");
    expect(shiftDate("2026-08-31", { months: -12 })).toBe("2025-08-31");
  });

  it("treats an absent shift as a no-op", () => {
    expect(shiftDate("2026-08-07", {})).toBe("2026-08-07");
  });

  it("rejects a malformed date", () => {
    expect(() => shiftDate("2026-02-30", { days: 1 })).toThrowError(/YYYY-MM-DD/);
  });
});

describe("exceedsMonthSpan", () => {
  // The four boundary probes run against the live API in PR #5, with
  // endDate = 2026-08-07 throughout.
  it.each([
    ["2025-08-07", false, "exactly 12 months is accepted"],
    ["2025-08-01", true, "12 months + 6 days is a 422"],
    ["2025-09-01", false, "11 months anchored to a month start is fine"],
    ["2025-07-01", true, "the 13-month window that caused the regression"],
  ])("%s → exceeds=%s (%s)", (startDate, expected) => {
    expect(exceedsMonthSpan(startDate, "2026-08-07")).toBe(expected);
  });

  it("is inclusive at the boundary and rejects one day past it", () => {
    const end = "2026-08-07";
    const boundary = shiftDate(end, { months: -LIST_MAX_SPAN_MONTHS });
    expect(exceedsMonthSpan(boundary, end)).toBe(false);
    expect(exceedsMonthSpan(shiftDate(boundary, { days: -1 }), end)).toBe(true);
  });

  it("honours a caller-supplied limit", () => {
    expect(exceedsMonthSpan("2026-06-07", "2026-08-07", 1)).toBe(true);
    expect(exceedsMonthSpan("2026-07-07", "2026-08-07", 1)).toBe(false);
  });
});

/**
 * Dates chosen to stress the arithmetic: month ends of every length, both sides
 * of a leap day, and the year boundary that motivated the rolling window.
 */
const STRESS_DATES = [
  "2026-01-01",
  "2026-01-05", // the January case a year-to-date window gets wrong
  "2026-01-31",
  "2026-02-28",
  "2026-03-01",
  "2026-03-31",
  "2026-04-30",
  "2026-06-30",
  "2026-08-07",
  "2026-08-31",
  "2026-11-30",
  "2026-12-31",
  "2027-02-28",
  "2028-02-28",
  "2028-02-29", // leap day
  "2028-03-01",
  "2029-02-28",
];

describe("defaultListWindow", () => {
  it("ends at today in Taipei and reaches back about a year", () => {
    expect(defaultListWindow("2026-08-07")).toEqual({
      startDate: "2025-08-08",
      endDate: "2026-08-07",
    });
  });

  it("uses today in Asia/Taipei, not the host timezone", () => {
    // 17:00Z on 6 August is already 01:00 on 7 August in Taipei.
    expect(at("2026-08-06T17:00:00Z", () => defaultListWindow().endDate)).toBe("2026-08-07");
  });

  // The invariant the regression violated: the default must always be a window
  // the API accepts. Asserting the shape ("13 months back") could not catch it.
  it.each(STRESS_DATES)("never exceeds the API's span limit (%s)", (today) => {
    const w = defaultListWindow(today);
    expect(exceedsMonthSpan(w.startDate, w.endDate)).toBe(false);
  });

  it.each(STRESS_DATES)("always covers the whole previous calendar month (%s)", (today) => {
    const w = defaultListWindow(today);
    const firstOfPreviousMonth = `${shiftDate(`${today.slice(0, 7)}-01`, { months: -1 }).slice(0, 7)}-01`;
    expect(w.startDate <= firstOfPreviousMonth).toBe(true);
  });

  it("keeps a day of slack under the limit so a boundary disagreement cannot 422", () => {
    for (const today of STRESS_DATES) {
      const w = defaultListWindow(today);
      expect(w.startDate > shiftDate(w.endDate, { months: -LIST_MAX_SPAN_MONTHS })).toBe(true);
    }
  });

  it("rejects a malformed endDate", () => {
    expect(() => defaultListWindow("2026-02-30")).toThrowError(/YYYY-MM-DD/);
  });
});

describe("simpanyListWindows", () => {
  it("returns a single window for a range already within the limit", () => {
    expect(simpanyListWindows("2026-01-01", "2026-06-30")).toEqual([
      { startDate: "2026-01-01", endDate: "2026-06-30" },
    ]);
  });

  it("splits a multi-year range into contiguous, API-legal windows", () => {
    const windows = simpanyListWindows("2023-01-01", "2026-08-07");
    expect(windows.length).toBeGreaterThan(3);
    expect(windows[0]?.startDate).toBe("2023-01-01");
    expect(windows.at(-1)?.endDate).toBe("2026-08-07");
    for (const w of windows) {
      expect(exceedsMonthSpan(w.startDate, w.endDate)).toBe(false);
      expect(w.startDate <= w.endDate).toBe(true);
    }
    // Contiguous: each window starts the day after the previous one ends.
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]?.startDate).toBe(shiftDate(windows[i - 1]!.endDate, { days: 1 }));
    }
  });

  it("produces legal windows even across leap days", () => {
    for (const w of simpanyListWindows("2027-03-01", "2029-06-30")) {
      expect(exceedsMonthSpan(w.startDate, w.endDate)).toBe(false);
    }
  });

  it("handles a single-day range", () => {
    expect(simpanyListWindows("2026-08-07", "2026-08-07")).toEqual([
      { startDate: "2026-08-07", endDate: "2026-08-07" },
    ]);
  });

  it("honours a smaller maxMonths", () => {
    const windows = simpanyListWindows("2026-01-01", "2026-06-30", 2);
    expect(windows[0]).toEqual({ startDate: "2026-01-01", endDate: "2026-02-28" });
    for (const w of windows) {
      expect(exceedsMonthSpan(w.startDate, w.endDate, 2)).toBe(false);
    }
    expect(windows.at(-1)?.endDate).toBe("2026-06-30");
  });

  // Sweeps the month-length and leap-day combinations that break naive
  // arithmetic, asserting the three properties callers depend on: every window
  // is one the API accepts, they are contiguous, and together they cover the
  // requested range exactly.
  it("holds its invariants across a sweep of start dates and limits", () => {
    for (const start of STRESS_DATES) {
      for (const months of [1, 2, 3, 12]) {
        const end = shiftDate(start, { months: 30 });
        const windows = simpanyListWindows(start, end, months);
        expect(windows[0]?.startDate).toBe(start);
        expect(windows.at(-1)?.endDate).toBe(end);
        for (const w of windows) {
          expect(exceedsMonthSpan(w.startDate, w.endDate, months)).toBe(false);
          expect(w.startDate <= w.endDate).toBe(true);
        }
        for (let i = 1; i < windows.length; i++) {
          expect(windows[i]?.startDate).toBe(shiftDate(windows[i - 1]!.endDate, { days: 1 }));
        }
      }
    }
  });

  it("rejects a reversed range", () => {
    expect(() => simpanyListWindows("2026-08-07", "2026-01-01")).toThrowError(/is after endDate/);
  });

  it.each([0, -1, 1.5])("rejects a maxMonths of %s", (maxMonths) => {
    expect(() => simpanyListWindows("2026-01-01", "2026-06-30", maxMonths)).toThrowError(
      /positive whole number/,
    );
  });
});

describe("taipeiToday / currentRocYear", () => {
  it("reads the Taipei calendar day, not UTC's", () => {
    expect(at("2026-08-06T17:00:00Z", taipeiToday)).toBe("2026-08-07");
    expect(at("2026-08-06T15:59:00Z", taipeiToday)).toBe("2026-08-06");
  });

  it("converts to a ROC year, including across the new year in Taipei", () => {
    expect(at("2026-08-06T17:00:00Z", currentRocYear)).toBe(115);
    // 16:00Z on 31 December is already 1 January in Taipei — ROC 116, not 115.
    expect(at("2026-12-31T16:00:00Z", currentRocYear)).toBe(116);
  });
});
