// @paid-tw/einvoice-simpany — Simpany (simpany.co) e-invoice adapter.
//
// The auth layer (login / me / company resolution) is verified against the live
// API. The five InvoiceProvider operations were compiled by hand and are
// UNVERIFIED against a live e-invoice-enabled account — they may be inaccurate;
// see provider.ts / endpoints.ts. Report discrepancies as GitHub issues.
export { createSimpanyProvider, SimpanyProvider } from "./provider.js";
export type {
  SimpanyIssueCapacity,
  SimpanyListReceiptsQuery,
  SimpanyTrackNumber,
} from "./provider.js";
export {
  LIST_MAX_SPAN_MONTHS,
  currentRocYear,
  defaultListWindow,
  exceedsMonthSpan,
  shiftDate,
  simpanyListWindows,
  taipeiToday,
} from "./dates.js";
export type { SimpanyConfig } from "./config.js";
export { SIMPANY_BASE_URL, SIMPANY_RECEIPT_BASE_URL } from "./config.js";
export {
  AUTH_ENDPOINTS as SIMPANY_AUTH_ENDPOINTS,
  RECEIPT_ENDPOINTS as SIMPANY_RECEIPT_ENDPOINTS,
} from "./endpoints.js";
export { isThrottled, mapSimpanyError, retryAfterSeconds, SimpanyClient } from "./client.js";
export type {
  SimpanyEnvelope,
  SimpanyLoginData,
  SimpanyMe,
  SimpanyCompany,
  SimpanyHost,
} from "./client.js";
export {
  simpanyTaxType,
  simpanyCarrier,
  toInvoiceStatus,
  trackUsage,
  SIMPANY_TAX_TYPE,
  SIMPANY_CARRIER_TYPE,
  SIMPANY_STATUS,
} from "./mapping.js";
export type { TrackNumberUsage } from "./mapping.js";
export { SIMPANY_TRACK_STATUS } from "./mapping.js";
