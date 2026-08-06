import {
  Capability,
  CarrierType,
  InvoiceError,
  InvoiceErrorCode,
  InvoiceStatus,
  TaxType,
  allowanceInputSchema,
  deriveCategory,
  issueInvoiceInputSchema,
  parseInput,
  parseTaipeiDate,
  queryInvoiceInputSchema,
  voidAllowanceInputSchema,
  voidInvoiceInputSchema,
  type AllowanceInput,
  type AllowanceResult,
  type InvoiceProvider,
  type IssueInvoiceInput,
  type IssueInvoiceResult,
  type QueryInvoiceInput,
  type QueryInvoiceResult,
  type VoidAllowanceInput,
  type VoidAllowanceResult,
  type VoidInvoiceInput,
  type VoidInvoiceResult,
} from "@paid-tw/einvoice";
import { SimpanyClient, type SimpanyCompany, type SimpanyMe } from "./client.js";
import { type SimpanyConfig } from "./config.js";
import {
  LIST_MAX_SPAN_MONTHS,
  assertIsoDate,
  currentRocYear,
  defaultListWindow,
  exceedsMonthSpan,
  taipeiToday,
} from "./dates.js";
import { RECEIPT_ENDPOINTS } from "./endpoints.js";
import {
  buyerEmails,
  simpanyCarrier,
  simpanyTaxType,
  toInvoiceStatus,
  toIssueItem,
  trackUsage,
  SIMPANY_TAX_TYPE,
  type TrackNumberUsage,
} from "./mapping.js";

/** One 字軌 row plus its usage counts (field names VERIFIED live — see PR #5). */
export interface SimpanyTrackNumber extends TrackNumberUsage {
  /** ROC (民國) year of the period, e.g. 115. */
  year?: number;
  /** Period month (1–12). */
  month?: number;
  /** The 字軌 letters, e.g. "AB". */
  track?: string;
  /** `ENABLED` | `EXPIRED` — see {@link SIMPANY_TRACK_STATUS}. An EXPIRED track's numbers have lapsed. */
  status?: string;
  /** Range bounds / cursor — digit strings on the wire (e.g. "12345000"). */
  beginNumber?: unknown;
  endNumber?: unknown;
  lastUsedNumber?: unknown;
  /** The raw track row as returned by Simpany. */
  raw: Record<string, unknown>;
}

/** Result of {@link SimpanyProvider.canIssue} — the two limits and which one binds. */
export interface SimpanyIssueCapacity {
  /** Whether `count` more invoices can be issued right now (both limits hold). */
  ok: boolean;
  /** The count that was checked. */
  count: number;
  /** Which limit is short, when `ok` is false. */
  bottleneck?: "SUBSCRIPTION" | "TRACK_NUMBER";
  /** Issues left on the Simpany plan. */
  subscriptionRemaining: number;
  /** The plan's raw status string (e.g. `"ACTIVE"`); not interpreted here. */
  subscriptionStatus: string;
  /** Unused invoice numbers across the enabled 字軌 — an upper bound, see `canIssue`. */
  trackRemaining: number;
  /** The enabled 字軌 behind `trackRemaining`. */
  tracks: SimpanyTrackNumber[];
}

/** Unwrap a list response to an array — bare `[...]`, `{ data:[...] }`, or `{ list:[...] }`. */
function toArray(res: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(res)) return res as Array<Record<string, unknown>>;
  const o = (res ?? {}) as { data?: unknown; list?: unknown };
  const inner = Array.isArray(o.data) ? o.data : Array.isArray(o.list) ? o.list : [];
  return inner as Array<Record<string, unknown>>;
}

const fail = (message: string, code: InvoiceErrorCode = InvoiceErrorCode.VALIDATION) =>
  new InvoiceError(message, { provider: "simpany", code, rawMessage: message });

/** Page size {@link SimpanyProvider.listReceipts} requests while paging through a window. */
export const LIST_PAGE_SIZE = 500;

/** Runaway guard on that loop — reaching it throws rather than truncating quietly. */
export const LIST_MAX_PAGES = 200;

/** Query params for {@link SimpanyProvider.listReceipts}. */
export interface SimpanyListReceiptsQuery {
  /** 發票狀態 — `"ALL"` (the default) or a Simpany status such as `"ISSUED"`. Required by the API. */
  status?: string;
  /**
   * Window start, `YYYY-MM-DD` (Asia/Taipei). Required by the API; defaults with
   * `endDate` to {@link defaultListWindow}. `endDate` minus `startDate` may not
   * exceed {@link LIST_MAX_SPAN_MONTHS} months — pass a longer range through
   * `simpanyListWindows()` instead.
   */
  startDate?: string;
  /** Window end, `YYYY-MM-DD` (Asia/Taipei). Required by the API; defaults to today. */
  endDate?: string;
  /** Fetch just this page. Opts out of paging through the window. */
  page?: number;
  /** Cap the rows and make a single request — a sample, not a page size. */
  limit?: number;
  /** Any other param Simpany accepts, forwarded verbatim. */
  [key: string]: string | number | undefined;
}

/** provider-specific fields callers may pass via `input.providerOptions`. */
interface SimpanyProviderOptions {
  /**
   * Simpany's INTERNAL receipt id (an issue result's `raw.id`, or a
   * {@link SimpanyProvider.listReceipts} row id) — REQUIRED by void / query /
   * allowance. There is no invoice-number lookup (see {@link SimpanyProvider}).
   */
  receiptId?: string | number;
  /** Simpany's INTERNAL allowance (or draft-allowance) id — required by voidAllowance. */
  allowanceId?: string | number;
  /** For voidAllowance: the allowance is still a DRAFT (待確認) → use the draft endpoint. */
  draft?: boolean;
  /** Recipients for the emailed invoice / allowance / void notice. */
  emails?: string[];
  /** ZERO_TAX_RATE only: 零稅率原因代碼 (see the zero-tax-rate-reasons endpoint). */
  zeroTaxRateReasonCode?: string;
  /** ZERO_TAX_RATE only: NOT_VIA_CUSTOMS | VIA_CUSTOMS (通關方式). */
  customsClearanceType?: string;
  /** B2B 稅額調整 (±1 rounding). */
  shouldAdjustTaxAmount?: boolean;
  /** Raw override of the allowance `items` (`[{ id, quantity, price }]`). */
  items?: Array<Record<string, unknown>>;
}

/**
 * Simpany (simpany.co) e-invoice provider.
 *
 * Verification status: the auth layer (`me` / `resolveCompanyId`) and the READ
 * path — routes, required list/track filters, detail response fields and enum
 * values — are verified against a live e-invoice-enabled account (PR #5).
 * ⚠️ The WRITE payloads (issue / void / allowance / void-allowance) remain
 * hand-compiled and UNVERIFIED — treat them as best-effort and file GitHub
 * issues for any discrepancy.
 *
 * Operations run on the receipt host (`member2.simpany.co`) and are scoped to a
 * company id (from config or resolved via `/me`). void / query / allowance key
 * off Simpany's INTERNAL receipt id — pass an issue result's `raw.id` back via
 * `providerOptions.receiptId` (REQUIRED). There is no invoice-number reverse
 * lookup: the list endpoint's filters are all required (see
 * {@link SimpanyProvider.listReceipts}) and its `keyword` param is unverified,
 * so the old best-effort lookup could never succeed (PR #5).
 */
export class SimpanyProvider implements InvoiceProvider {
  readonly name = "simpany";

  // No MIXED_TAX (taxType is invoice-level only), no FOREIGN_CURRENCY, no
  // CARRIER_VALIDATION endpoint in the client.
  readonly capabilities: ReadonlySet<Capability> = new Set([
    Capability.ISSUE,
    Capability.VOID,
    Capability.ALLOWANCE,
    Capability.VOID_ALLOWANCE,
    Capability.QUERY,
    Capability.B2B,
  ]);

  private readonly client: SimpanyClient;
  private companyId?: string | number;

  constructor(private readonly config: SimpanyConfig) {
    this.client = new SimpanyClient(config);
    this.companyId = config.companyId;
  }

  /** The account and its companies — useful for discovering `companyId` / permissions. */
  async me(): Promise<SimpanyMe> {
    return this.client.me();
  }

  /**
   * Resolve the company id: `config.companyId` if given, else from `GET /v1/me` —
   * the company matching `config.companyUbn`, or the sole company. Cached.
   */
  async resolveCompanyId(): Promise<string | number> {
    if (this.companyId != null) return this.companyId;
    const me = await this.client.me();
    const companies = me.companies ?? [];
    const picked: SimpanyCompany | undefined = this.config.companyUbn
      ? companies.find((c) => c.ubn === this.config.companyUbn)
      : companies.length === 1
        ? companies[0]
        : undefined;
    if (!picked) {
      if (this.config.companyUbn) {
        throw new InvoiceError(`Simpany: no company matches ubn ${this.config.companyUbn}`, {
          provider: "simpany",
          code: InvoiceErrorCode.NOT_FOUND,
          rawMessage: "company not found",
        });
      }
      throw new InvoiceError(
        `Simpany: account has ${companies.length} companies — set config.companyId or companyUbn`,
        { provider: "simpany", code: InvoiceErrorCode.VALIDATION, rawMessage: "ambiguous company" },
      );
    }
    this.companyId = picked.id;
    return this.companyId;
  }

  /** 開立發票. `POST /c/{companyId}/receipts/{b2b|b2c}`. */
  async issue(input: IssueInvoiceInput): Promise<IssueInvoiceResult> {
    parseInput(issueInvoiceInputSchema, input, "simpany");
    const category = input.category ?? deriveCategory(input.buyer); // "B2B" | "B2C"
    if (this.config.validatePayload !== false) this.validateIssue(input, category);
    const cid = await this.resolveCompanyId();
    const body = this.buildIssueBody(input, category);
    const r = await this.client.receipt<Record<string, unknown>>(
      "POST",
      RECEIPT_ENDPOINTS.issue(cid, category),
      body,
    );
    return {
      invoiceNumber: String(r.invoiceNumber ?? r.number ?? ""),
      invoiceDate: parseTaipeiDate(r.issuedAt ?? r.createdAt),
      randomCode: String(r.randomNumber ?? r.randomCode ?? ""),
      orderId: input.orderId,
      totalAmount: Number(r.totalAmount ?? input.amount.totalAmount),
      status: toInvoiceStatus(r.status),
      raw: r,
    };
  }

  /** 作廢發票. `DELETE /c/{companyId}/receipts/{receiptId}` with `{ reason, emails }`. */
  async void(input: VoidInvoiceInput): Promise<VoidInvoiceResult> {
    parseInput(voidInvoiceInputSchema, input, "simpany");
    const opts = (input.providerOptions ?? {}) as SimpanyProviderOptions;
    const receiptId = requireReceiptId("void", opts);
    const cid = await this.resolveCompanyId();
    const r = await this.client.receipt("DELETE", RECEIPT_ENDPOINTS.void(cid, receiptId), {
      reason: input.reason,
      emails: opts.emails ?? [],
    });
    return { invoiceNumber: input.invoiceNumber, status: InvoiceStatus.VOIDED, raw: r };
  }

  /**
   * 開立折讓 — creates a DRAFT allowance:
   * `POST /c/{companyId}/receipts/{receiptId}/draft-allowances` with
   * `{ emails, items:[{ id, quantity, price }] }`. Each item's `id` is the
   * original receipt line id; unless overridden via `providerOptions.items`, the
   * lines are matched to the invoice's items positionally (a detail lookup).
   */
  async allowance(input: AllowanceInput): Promise<AllowanceResult> {
    parseInput(allowanceInputSchema, input, "simpany");
    const opts = (input.providerOptions ?? {}) as SimpanyProviderOptions;
    const receiptId = requireReceiptId("allowance", opts);
    const cid = await this.resolveCompanyId();

    let items = opts.items;
    if (!items) {
      const detail = await this.client.receipt<{ items?: Array<{ id?: string | number }> }>(
        "GET",
        RECEIPT_ENDPOINTS.detail(cid, receiptId),
      );
      const lines = detail.items ?? [];
      items = input.items.map((it, i) => {
        const id = lines[i]?.id;
        if (id == null && this.config.validatePayload !== false) {
          throw fail(
            `Simpany allowance: could not match item #${i} to an invoice line — ` +
              `pass providerOptions.items ([{ id, quantity, price }]) explicitly`,
          );
        }
        return { id, quantity: it.quantity, price: it.amount };
      });
    }

    const r = await this.client.receipt<Record<string, unknown>>(
      "POST",
      RECEIPT_ENDPOINTS.issueAllowance(cid, receiptId),
      { emails: opts.emails ?? [], items },
    );
    return {
      allowanceNumber: String(r.allowanceNumber ?? ""),
      invoiceNumber: input.invoiceNumber,
      allowanceDate: parseTaipeiDate(r.issuedAt ?? r.createdAt),
      totalAmount: input.amount.totalAmount,
      raw: r,
    };
  }

  /**
   * 作廢折讓. Keyed by Simpany's INTERNAL allowance id (`providerOptions.allowanceId`):
   * `DELETE /c/{companyId}/allowances/{id}` — or `/draft-allowances/{id}` when
   * `providerOptions.draft` (the allowance is still 待確認). Body `{ reason, emails }`.
   */
  async voidAllowance(input: VoidAllowanceInput): Promise<VoidAllowanceResult> {
    parseInput(voidAllowanceInputSchema, input, "simpany");
    const opts = (input.providerOptions ?? {}) as SimpanyProviderOptions;
    const allowanceId = opts.allowanceId;
    if (allowanceId == null) {
      throw fail("Simpany voidAllowance requires providerOptions.allowanceId (the internal id)");
    }
    const cid = await this.resolveCompanyId();
    const path = opts.draft
      ? RECEIPT_ENDPOINTS.voidDraftAllowance(cid, allowanceId)
      : RECEIPT_ENDPOINTS.voidAllowance(cid, allowanceId);
    const r = await this.client.receipt("DELETE", path, {
      reason: input.reason ?? "作廢折讓",
      emails: opts.emails ?? [],
    });
    return { allowanceNumber: input.allowanceNumber, raw: r };
  }

  /** 查詢發票. `GET /c/{companyId}/receipts/{receiptId}`. */
  async query(input: QueryInvoiceInput): Promise<QueryInvoiceResult> {
    parseInput(queryInvoiceInputSchema, input, "simpany");
    const opts = (input.providerOptions ?? {}) as SimpanyProviderOptions;
    const receiptId = requireReceiptId("query", opts);
    const cid = await this.resolveCompanyId();
    const r = await this.client.receipt<Record<string, unknown>>(
      "GET",
      RECEIPT_ENDPOINTS.detail(cid, receiptId),
    );
    const total = Number(r.totalAmount ?? 0);
    const tax = Number(r.taxAmount ?? 0);
    // `untaxedAmount` is the verified field name (and authoritative when the B2B
    // ±1 tax adjustment makes untaxed + tax ≠ total).
    const sales = r.untaxedAmount != null ? Number(r.untaxedAmount) : total - tax;
    const emails = (r.buyerEmails as string[] | undefined) ?? [];
    return {
      invoiceNumber: String(r.invoiceNumber ?? ""),
      invoiceDate: parseTaipeiDate(r.issuedAt ?? r.createdAt),
      randomCode: String(r.randomNumber ?? ""),
      orderId: r.customId ? String(r.customId) : undefined,
      status: toInvoiceStatus(r.status),
      amount: { salesAmount: sales, taxAmount: tax, totalAmount: total },
      buyer: {
        name: r.buyerName ? String(r.buyerName) : undefined,
        ubn: r.buyerVat ? String(r.buyerVat) : undefined,
        address: r.buyerAddress ? String(r.buyerAddress) : undefined,
        email: emails[0],
      },
      items: ((r.items as Array<Record<string, unknown>>) ?? []).map((p) => ({
        description: String(p.name ?? ""),
        quantity: Number(p.quantity ?? 0),
        unitPrice: Number(p.price ?? p.amount ?? 0),
        amount: Number(p.amount ?? 0),
      })),
      raw: r,
    };
  }

  /**
   * Local pre-flight validation for issue, mirroring the web form's rules
   * (client-side; the server contract is UNVERIFIED). Toggle off with
   * `config.validatePayload === false`. Throws `InvoiceError(VALIDATION)`.
   */
  private validateIssue(input: IssueInvoiceInput, category: string): void {
    if (category === "B2B" && !input.buyer.name) {
      throw fail("Simpany B2B issue requires buyer.name");
    }
    // The web form requires an email on every issue (the notification recipient).
    if (!input.buyer.email) {
      throw fail("Simpany issue requires buyer.email (the invoice notification recipient)");
    }
    input.items.forEach((it, i) => {
      if (it.description.length > 255) throw fail(`item #${i}: description exceeds 255 chars`);
      if (!(it.quantity >= 1 && it.quantity <= 999999)) {
        throw fail(`item #${i}: quantity must be between 1 and 999999`);
      }
      if (!(it.unitPrice >= 0 && it.unitPrice <= 99_999_999)) {
        throw fail(`item #${i}: unitPrice must be between 0 and 99999999`);
      }
    });
    if (input.carrier) {
      const code = input.carrier.code ?? "";
      if (input.carrier.type === CarrierType.MOBILE_BARCODE && !/^\/[0-9A-Z+.-]{7}$/.test(code)) {
        throw fail("mobile-barcode carrier.code must be '/' + 7 chars of [0-9 A-Z + . -]");
      }
      if (
        input.carrier.type === CarrierType.CITIZEN_CERTIFICATE &&
        !/^[A-Z]{2}[0-9]{14}$/.test(code)
      ) {
        throw fail("citizen-certificate carrier.code must be 2 letters + 14 digits (16 chars)");
      }
    }
    if (input.taxType === TaxType.ZERO_RATED) {
      const opts = (input.providerOptions ?? {}) as SimpanyProviderOptions;
      if (!opts.zeroTaxRateReasonCode) {
        throw fail(
          "zero-rated issue requires providerOptions.zeroTaxRateReasonCode " +
            "(valid codes come from the receipts/zero-tax-rate-reasons endpoint)",
        );
      }
    }
    if (category === "B2C" && input.donation && !/^\d{3,7}$/.test(input.donation.npoban)) {
      throw fail("donation.npoban (愛心碼) must be 3–7 digits");
    }
  }

  // --- read-only helpers (extensions beyond InvoiceProvider) -----------------
  // Handy to confirm the integration is wired correctly WITHOUT issuing anything:
  // they exercise auth + company scope + a real receipt-host GET.

  /**
   * 發票列表 — list issued invoices (raw rows). Read-only.
   *
   * The API REQUIRES `status` + `startDate` + `endDate`, all three (verified
   * live: anything less is a 422, and `yearMonth` is not accepted). They default
   * to `status=ALL` over {@link defaultListWindow} — the ~12 months ending
   * today, NOT the calendar year, which would be only a few days wide every
   * January.
   *
   * The window may not exceed {@link LIST_MAX_SPAN_MONTHS} months; a longer one
   * is rejected here with `VALIDATION` rather than left to come back as the
   * API's 422. To read further back, loop over `simpanyListWindows()`.
   *
   * **Pages through the whole window by default.** The response is a bare array
   * with no `total`, no `lastPage`, no `meta` of any kind, so a caller handed
   * one page has no way to tell it is holding a partial answer — and a
   * duplicate check that silently sees only the first page issues a second
   * invoice for an order that was already invoiced. Two ways to opt out, both
   * one request:
   *
   * - pass `page` to drive pagination yourself;
   * - pass `limit` to cap the rows (`{ limit: 5 }` reads a sample, it does not
   *   page through in fives).
   */
  async listReceipts(
    query: SimpanyListReceiptsQuery = {},
  ): Promise<Array<Record<string, unknown>>> {
    const { status, startDate, endDate, page, limit, ...rest } = query;
    const window = resolveListWindow(startDate, endDate);
    const cid = await this.resolveCompanyId();

    const base = new URLSearchParams({ status: status ?? "ALL", ...window });
    for (const [k, v] of Object.entries(rest)) {
      if (v !== undefined) base.set(k, String(v));
    }
    const fetchPage = async (params: Record<string, number> = {}) => {
      const qs = new URLSearchParams(base);
      for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
      return toArray(
        await this.client.receipt<unknown>(
          "GET",
          `${RECEIPT_ENDPOINTS.list(cid)}?${qs.toString()}`,
        ),
      );
    };

    if (page !== undefined || limit !== undefined) {
      return fetchPage({
        ...(page !== undefined ? { page: Number(page) } : {}),
        ...(limit !== undefined ? { limit: Number(limit) } : {}),
      });
    }

    const rows: Array<Record<string, unknown>> = [];
    for (let p = 1; p <= LIST_MAX_PAGES; p++) {
      const batch = await fetchPage({ page: p, limit: LIST_PAGE_SIZE });
      rows.push(...batch);
      // Only an empty page ends the loop. A short one is not proof of the end:
      // the server may cap `limit` below what was asked for, and stopping the
      // moment a page came back smaller than requested would drop everything
      // past the cap — the same silent truncation this loop exists to avoid.
      if (batch.length === 0) return rows;
    }
    throw fail(
      `Simpany listReceipts: still receiving rows after ${LIST_MAX_PAGES} pages of ` +
        `${LIST_PAGE_SIZE}. Narrow the date window, or pass \`page\` to paginate yourself.`,
      InvoiceErrorCode.PROVIDER,
    );
  }

  /**
   * 字軌列表 — list this company's invoice-number tracks with usage counts
   * (`remaining` comes straight from the API's `remainingQuantity`). Read-only;
   * the ideal smoke test that the integration is wired (auth + permission +
   * routing) without issuing anything.
   *
   * The API REQUIRES `year`, in ROC (民國) years — e.g. 115 for 2026 (verified
   * live: omitting it is a 422). It defaults to the current Taipei year. A
   * Gregorian year is rejected here with VALIDATION because the API silently
   * returns an empty list for one — which downstream reads as "tracks
   * exhausted". `enabledOnly` uses `/track-numbers/enabled`, which takes no year.
   */
  async listTrackNumbers(
    opts: { enabledOnly?: boolean; year?: number } = {},
  ): Promise<SimpanyTrackNumber[]> {
    let query = "";
    if (!opts.enabledOnly) {
      const year = opts.year ?? currentRocYear();
      if (year > 1911) {
        throw fail(
          `listTrackNumbers: year must be a ROC (民國) year, e.g. ${currentRocYear()} — got ` +
            `${year}. The API silently returns an empty list for a Gregorian year.`,
        );
      }
      query = `?year=${year}`;
    }
    const cid = await this.resolveCompanyId();
    const path = opts.enabledOnly
      ? RECEIPT_ENDPOINTS.trackNumbersEnabled(cid)
      : `${RECEIPT_ENDPOINTS.trackNumbers(cid)}${query}`;
    const res = await this.client.receipt<unknown>("GET", path);
    return toArray(res).map((row) => ({
      year: typeof row.year === "number" ? row.year : undefined,
      month: typeof row.month === "number" ? row.month : undefined,
      track: row.track != null ? String(row.track) : undefined,
      status: row.status != null ? String(row.status) : undefined,
      beginNumber: row.beginNumber,
      endNumber: row.endNumber,
      lastUsedNumber: row.lastUsedNumber,
      ...trackUsage(row),
      raw: row,
    }));
  }

  /**
   * 補寄 / 寄送發票通知信 — POST /c/{cid}/receipts/{id}/notifications `{ emails }`.
   * The rescue path when a consumer gave a wrong email at checkout: re-send the
   * invoice to a corrected address. Keyed by Simpany's internal receipt id (an
   * issue result's `raw.id`).
   */
  async notifyReceipt(receiptId: string | number, emails: string[]): Promise<void> {
    const cid = await this.resolveCompanyId();
    await this.client.receipt("POST", RECEIPT_ENDPOINTS.notify(cid, receiptId), { emails });
  }

  /**
   * 下載發票證明聯 PDF — POST /c/{cid}/receipts/{id}/print. Keyed by Simpany's
   * internal receipt id (an issue result's `raw.id`). Returns the raw PDF bytes +
   * content type. `format` (e.g. `"FORMAT_A4"`) and `reprint` are passed through;
   * `reprint` marks it as a 補印本.
   */
  async printReceipt(
    receiptId: string | number,
    opts: { format?: string; reprint?: boolean } = {},
  ): Promise<{ contentType: string; data: Uint8Array }> {
    const cid = await this.resolveCompanyId();
    return this.client.receiptFile("POST", RECEIPT_ENDPOINTS.print(cid, receiptId), {
      ...(opts.format ? { format: opts.format } : {}),
      ...(opts.reprint != null ? { isReprint: opts.reprint } : {}),
    });
  }

  /**
   * 訂閱狀態 / 剩餘可開立張數 — GET /c/{cid}/subscription-status →
   * `{ status, remainingQuantity }`. Read-only; the plan-level quota (distinct
   * from the 字軌 number ranges reported by {@link listTrackNumbers}). Handy as a
   * pre-issue quota check and as a wiring smoke test.
   */
  async getSubscriptionStatus(): Promise<{
    status: string;
    remainingQuantity: number;
    raw: Record<string, unknown>;
  }> {
    const cid = await this.resolveCompanyId();
    const r = await this.client.receipt<Record<string, unknown>>(
      "GET",
      RECEIPT_ENDPOINTS.subscriptionStatus(cid),
    );
    return {
      status: String(r.status ?? ""),
      remainingQuantity: Number(r.remainingQuantity ?? 0),
      raw: r,
    };
  }

  /**
   * 開立前額度預檢 — can this company issue `count` more invoices right now?
   * Read-only; combines the two independent limits that both have to hold, and
   * names whichever one is short:
   *
   * - the **plan quota** ({@link getSubscriptionStatus}) — issues you have paid for;
   * - the **invoice numbers** left across the ENABLED 字軌 ({@link listTrackNumbers}).
   *
   * On a subscription plan the quota is often far smaller than the allocated
   * number ranges, so checking only the 字軌 reads as optimistic.
   *
   * Counts ENABLED tracks only, which is not merely a tidiness choice: an
   * EXPIRED track keeps its `remainingQuantity` (a lapsed period was observed
   * still reporting all 200 numbers unused), so including them would overstate
   * capacity by whole periods.
   *
   * `tracks` carries the per-track breakdown. `trackRemaining` is still an upper
   * bound: a live account showed only the current period enabled, but that is
   * one account at one moment and does not rule out a future 期別 being enabled
   * early — inspect `tracks[].year` / `.month` when that matters.
   */
  async canIssue(count = 1): Promise<SimpanyIssueCapacity> {
    const quota = await this.getSubscriptionStatus();
    const tracks = await this.listTrackNumbers({ enabledOnly: true });
    const trackRemaining = tracks.reduce((sum, t) => sum + t.remaining, 0);
    const short = quota.remainingQuantity < count || trackRemaining < count;
    return {
      ok: !short,
      count,
      // On a tie both are equally binding; report the plan quota, the one the
      // caller can actually act on without waiting for a number allocation.
      bottleneck: !short
        ? undefined
        : quota.remainingQuantity <= trackRemaining
          ? "SUBSCRIPTION"
          : "TRACK_NUMBER",
      subscriptionRemaining: quota.remainingQuantity,
      subscriptionStatus: quota.status,
      trackRemaining,
      tracks,
    };
  }

  /**
   * 常用品項 — list reusable line-item presets (GET /c/{cid}/frequent-items).
   * Read-only; returns the raw rows.
   */
  async listFrequentItems(): Promise<Array<Record<string, unknown>>> {
    const cid = await this.resolveCompanyId();
    const res = await this.client.receipt<unknown>("GET", RECEIPT_ENDPOINTS.frequentItems(cid));
    return toArray(res);
  }

  /** Build the issue payload (Simpany `parseData` shape). */
  private buildIssueBody(input: IssueInvoiceInput, category: string): Record<string, unknown> {
    const opts = (input.providerOptions ?? {}) as SimpanyProviderOptions;
    const isB2B = category === "B2B";
    const taxType = simpanyTaxType(input.taxType);
    const isZeroRate = taxType === SIMPANY_TAX_TYPE.ZERO_TAX_RATE;
    const emails = buyerEmails(input.buyer);
    return {
      customId: input.orderId,
      customer: isB2B
        ? {
            vat: input.buyer.ubn ?? null,
            name: input.buyer.name,
            address: input.buyer.address,
            emails,
          }
        : { name: input.buyer.name, address: input.buyer.address, emails },
      taxType,
      customsClearanceType: isZeroRate ? (opts.customsClearanceType ?? "NOT_VIA_CUSTOMS") : null,
      remark: input.remark ?? "",
      isTaxIncluded: input.priceMode === "TAX_INCLUSIVE",
      shouldAdjustTaxAmount: Boolean(opts.shouldAdjustTaxAmount),
      carrier: simpanyCarrier(input.carrier),
      npoBan: !isB2B && input.donation ? input.donation.npoban : null,
      items: input.items.map(toIssueItem),
      zeroTaxRateReasonCode: isZeroRate ? (opts.zeroTaxRateReasonCode ?? null) : null,
    };
  }
}

/**
 * Settle the receipt list's date window and reject anything the API would 422.
 *
 * `endDate` defaults to today and `startDate` to twelve months before whichever
 * `endDate` is in play, so supplying just one end still yields a sane window —
 * `{ endDate: "2024-06-30" }` reads the year up to that date, not a backwards
 * range starting today.
 */
function resolveListWindow(
  startDate?: string,
  endDate?: string,
): { startDate: string; endDate: string } {
  const end = endDate ?? taipeiToday();
  assertIsoDate(end, "endDate");
  const start = startDate ?? defaultListWindow(end).startDate;
  assertIsoDate(start, "startDate");
  if (start > end) {
    throw fail(`Simpany listReceipts: startDate ${start} is after endDate ${end}`);
  }
  if (exceedsMonthSpan(start, end)) {
    throw fail(
      `Simpany listReceipts: ${start} … ${end} is longer than the API's ` +
        `${LIST_MAX_SPAN_MONTHS}-month window limit (the API answers a longer one with a 422). ` +
        `Read further back by looping over simpanyListWindows("${start}", "${end}").`,
    );
  }
  return { startDate: start, endDate: end };
}

/**
 * Simpany's internal receipt id — REQUIRED via `providerOptions.receiptId` (an
 * issue result's `raw.id`, or a {@link SimpanyProvider.listReceipts} row id).
 * The old best-effort invoice-number lookup was removed: the list endpoint
 * requires `status` + `startDate` + `endDate` (verified live — the lookup's
 * request could only ever 422) and its `keyword` filter is unverified (PR #5).
 */
function requireReceiptId(op: string, opts: SimpanyProviderOptions): string | number {
  if (opts.receiptId != null) return opts.receiptId;
  throw fail(
    `Simpany ${op} requires providerOptions.receiptId — Simpany keys off its internal ` +
      `receipt id (an issue result's raw.id or a listReceipts() row id), not the invoice number`,
  );
}

/** Create a Simpany {@link InvoiceProvider}. */
export function createSimpanyProvider(config: SimpanyConfig): SimpanyProvider {
  return new SimpanyProvider(config);
}
