import { InvoiceError, InvoiceErrorCode, taipeiDateTime } from "@paid-tw/einvoice";

/**
 * Date arithmetic for Simpany's receipt list and 字軌 endpoints.
 *
 * Kept apart from the provider because the endpoints impose two calendar rules
 * that are easy to violate and expensive to get wrong, and both are far easier
 * to pin down with direct unit tests than through HTTP round-trips:
 *
 * - the receipt list rejects a window longer than {@link LIST_MAX_SPAN_MONTHS};
 * - 字軌 are addressed by ROC (民國) year, and a Gregorian year is accepted with
 *   an empty result rather than an error.
 *
 * All dates here are `YYYY-MM-DD` in Asia/Taipei, the timezone the API works in.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The longest `startDate … endDate` window the receipt list accepts, in months.
 *
 * VERIFIED live (PR #5): exactly 12 months is accepted and 12 months + 1 day is
 * a 422 that names both bounds, so the server's rule is
 * `startDate >= endDate − 12 months`, inclusive. Read further back by looping
 * over {@link simpanyListWindows}.
 */
export const LIST_MAX_SPAN_MONTHS = 12;

const fail = (message: string) =>
  new InvoiceError(message, {
    provider: "simpany",
    code: InvoiceErrorCode.VALIDATION,
    rawMessage: message,
  });

function format(d: Date): string {
  const y = String(d.getUTCFullYear()).padStart(4, "0");
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Today in Asia/Taipei as `YYYY-MM-DD`. */
export function taipeiToday(): string {
  return taipeiDateTime(new Date()).slice(0, 10);
}

/** The current Asia/Taipei year as a ROC (民國) year — e.g. 2026 → 115. */
export function currentRocYear(): number {
  return Number(taipeiToday().slice(0, 4)) - 1911;
}

/** Whether `value` is a well-formed `YYYY-MM-DD` calendar date (2026-02-30 is not). */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  return format(new Date(Date.UTC(y, m - 1, d))) === value;
}

/** Throw a `VALIDATION` {@link InvoiceError} unless `value` is a `YYYY-MM-DD` date. */
export function assertIsoDate(value: unknown, label: string): asserts value is string {
  if (!isIsoDate(value)) {
    throw fail(
      `Simpany: ${label} must be a YYYY-MM-DD calendar date in Asia/Taipei, got ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Shift a `YYYY-MM-DD` date by whole months and/or days.
 *
 * Month arithmetic OVERFLOWS instead of clamping: 31 March minus one month is
 * 3 March, and 29 February minus twelve months is 1 March. That is deliberate —
 * it is what the server's own date library does, so client and server agree on
 * where the window boundary falls.
 */
export function shiftDate(date: string, shift: { months?: number; days?: number }): string {
  assertIsoDate(date, "date");
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return format(new Date(Date.UTC(y, m - 1 + (shift.months ?? 0), d + (shift.days ?? 0))));
}

/**
 * Whether `startDate … endDate` is longer than the list endpoint allows.
 * Mirrors the server's own rule: it rejects unless `startDate` is on or after
 * `endDate` minus `maxMonths` months.
 */
export function exceedsMonthSpan(
  startDate: string,
  endDate: string,
  maxMonths: number = LIST_MAX_SPAN_MONTHS,
): boolean {
  return startDate < shiftDate(endDate, { months: -maxMonths });
}

/**
 * The receipt list's default window: the ~12 months ending at `endDate` (today
 * in Taipei unless given).
 *
 * Deliberately NOT the calendar year. A year-to-date window is only a few days
 * wide every January, and a pre-issue duplicate check that reads "nothing
 * found" there issues a second invoice for an order already invoiced in
 * December — which, once the period has closed, can only be undone with an
 * allowance.
 *
 * It stops one day short of {@link LIST_MAX_SPAN_MONTHS} so that a disagreement
 * with the server's month arithmetic at a leap-day boundary can never turn the
 * zero-argument call into a 422.
 */
export function defaultListWindow(endDate: string = taipeiToday()): {
  startDate: string;
  endDate: string;
} {
  assertIsoDate(endDate, "endDate");
  return {
    startDate: shiftDate(endDate, { months: -LIST_MAX_SPAN_MONTHS, days: 1 }),
    endDate,
  };
}

/**
 * Split `startDate … endDate` into consecutive windows the receipt list will
 * accept — the supported way to read further back than
 * {@link LIST_MAX_SPAN_MONTHS} months, since the endpoint has no way to express
 * a longer range:
 *
 * ```ts
 * const rows = [];
 * for (const w of simpanyListWindows("2023-01-01", "2026-08-07")) {
 *   rows.push(...(await provider.listReceipts(w)));
 * }
 * ```
 *
 * Windows are contiguous — no gap, no overlap — and cover the range exactly.
 */
export function simpanyListWindows(
  startDate: string,
  endDate: string,
  maxMonths: number = LIST_MAX_SPAN_MONTHS,
): Array<{ startDate: string; endDate: string }> {
  assertIsoDate(startDate, "startDate");
  assertIsoDate(endDate, "endDate");
  if (startDate > endDate) {
    throw fail(`Simpany: startDate ${startDate} is after endDate ${endDate}`);
  }
  if (!Number.isInteger(maxMonths) || maxMonths < 1) {
    throw fail(`Simpany: maxMonths must be a positive whole number of months, got ${maxMonths}`);
  }

  const windows: Array<{ startDate: string; endDate: string }> = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    // A day short of the limit, matching defaultListWindow's margin, so no
    // chunk can land exactly on a boundary the server rounds differently.
    const limit = shiftDate(cursor, { months: maxMonths, days: -1 });
    let chunkEnd = limit < endDate ? limit : endDate;
    // Month arithmetic does not round-trip across a short month — 1 March plus
    // two months less a day is 30 April, yet 30 April minus two months overflows
    // to 2 March — so the candidate is measured against the rule that actually
    // governs (which reckons from the END of the window) and given back a day at
    // a time until it holds. A single-day window always does, so this terminates.
    while (chunkEnd > cursor && exceedsMonthSpan(cursor, chunkEnd, maxMonths)) {
      chunkEnd = shiftDate(chunkEnd, { days: -1 });
    }
    windows.push({ startDate: cursor, endDate: chunkEnd });
    cursor = shiftDate(chunkEnd, { days: 1 });
  }
  return windows;
}
