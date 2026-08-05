/**
 * Simpany endpoints.
 *
 * There are TWO hosts, both authenticated with the SAME login JWT:
 *   - AUTH base   `https://api.simpany.co/v1`         — login / me (VERIFIED live)
 *   - RECEIPT base `https://member2.simpany.co/api/v1` — the e-invoice ("receipt")
 *     operations, all scoped `/c/{companyId}/...`
 *
 * The RECEIPT endpoints and payloads below were compiled by hand and are NOT
 * from a published API, NOT yet confirmed against a live e-invoice-enabled
 * account, and may be inaccurate. Treat them as a best-effort starting point;
 * please file discrepancies as GitHub issues.
 *
 * `{id}` is Simpany's INTERNAL receipt/allowance id (the `id` field on a list/
 * detail row), NOT the 發票號碼 / 折讓單號.
 */

/** AUTH endpoints, relative to the auth base (`api.simpany.co/v1`). */
export const AUTH_ENDPOINTS = {
  /** 登入取得 JWT. Body `{ account, password }` → `{ status:"ok", data:{ id, token } }`. */
  login: "/login",
  /** 帳號 + 名下公司（companies[].permissions gate every feature; e-invoice = `e_receipt`）. */
  me: "/me",
} as const;

/**
 * RECEIPT endpoints, relative to the receipt base (`member2.simpany.co/api/v1`).
 * `c` = companyId.
 */
export const RECEIPT_ENDPOINTS = {
  /** 開立發票. `type` is "b2b" | "b2c" (lowercased). Body = the issue payload. */
  issue: (c: string | number, type: string) => `/c/${c}/receipts/${type.toLowerCase()}`,
  /** 發票列表. Query `{ status, startDate, endDate, yearMonth, page, limit }`. */
  list: (c: string | number) => `/c/${c}/receipts`,
  /** 發票明細（by internal id）→ `.data`. */
  detail: (c: string | number, id: string | number) => `/c/${c}/receipts/${id}`,
  /** 作廢發票（DELETE, by internal id）. Body `{ reason, emails }`. */
  void: (c: string | number, id: string | number) => `/c/${c}/receipts/${id}`,
  /** 開立折讓（creates a DRAFT allowance）. Body `{ emails, items:[{ id, quantity, price }] }`. */
  issueAllowance: (c: string | number, receiptId: string | number) =>
    `/c/${c}/receipts/${receiptId}/draft-allowances`,
  /** 作廢「已確認」折讓（DELETE, by allowance id）. Body `{ reason, emails }`. */
  voidAllowance: (c: string | number, allowanceId: string | number) =>
    `/c/${c}/allowances/${allowanceId}`,
  /** 作廢「未確認」折讓（DELETE, by draft-allowance id）. Body `{ reason, emails }`. */
  voidDraftAllowance: (c: string | number, draftId: string | number) =>
    `/c/${c}/draft-allowances/${draftId}`,
  /** 折讓列表. */
  allowanceList: (c: string | number) => `/c/${c}/allowances`,
  /** 折讓明細（by allowance id）→ `.data`. */
  allowanceDetail: (c: string | number, allowanceId: string | number) =>
    `/c/${c}/allowances/${allowanceId}`,
  /** 發票通知信. Body `{ emails }`. */
  notify: (c: string | number, id: string | number) => `/c/${c}/receipts/${id}/notifications`,
  /** 折讓通知信. Body `{ emails }`. */
  notifyAllowance: (c: string | number, id: string | number) =>
    `/c/${c}/allowances/${id}/notifications`,
  /** 列印發票（PDF）. Body `{ format, isReprint }`. */
  print: (c: string | number, id: string | number) => `/c/${c}/receipts/${id}/print`,
  /** 列印折讓（PDF）. Body `{ format:"FORMAT_A4" }`. */
  printAllowance: (c: string | number, id: string | number) => `/c/${c}/allowances/${id}/print`,
  /** 批次開立（multipart csvFile）. */
  batches: (c: string | number) => `/c/${c}/receipts/batches`,
  /** 批次檔驗證（multipart csvFile）. */
  batchValidation: (c: string | number) => `/c/${c}/receipts/batches/validation`,
  /** 批次結果下載（by batch id）. */
  batchDownload: (c: string | number, batchId: string | number) =>
    `/c/${c}/receipts/batches/${batchId}/download`,
  /** 匯出 Excel. */
  export: (c: string | number) => `/c/${c}/receipts/export`,
  /** 中獎發票（by yearMonth）. */
  winning: (c: string | number, yearMonth: string) => `/c/${c}/winning-receipts/${yearMonth}`,
  /** 零稅率原因清單. */
  zeroTaxReasons: (c: string | number) => `/c/${c}/receipts/zero-tax-rate-reasons`,
} as const;
