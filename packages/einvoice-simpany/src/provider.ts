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
  taipeiDateTime,
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
  /** Range bounds / cursor — digit strings on the wire (e.g. "12345000"). */
  beginNumber?: unknown;
  endNumber?: unknown;
  lastUsedNumber?: unknown;
  /** The raw track row as returned by Simpany. */
  raw: Record<string, unknown>;
}

/** Unwrap a list response to an array — bare `[...]`, `{ data:[...] }`, or `{ list:[...] }`. */
function toArray(res: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(res)) return res as Array<Record<string, unknown>>;
  const o = (res ?? {}) as { data?: unknown; list?: unknown };
  const inner = Array.isArray(o.data) ? o.data : Array.isArray(o.list) ? o.list : [];
  return inner as Array<Record<string, unknown>>;
}

const fail = (message: string, code = InvoiceErrorCode.VALIDATION) =>
  new InvoiceError(message, { provider: "simpany", code, rawMessage: message });

/** The current year in Asia/Taipei as a ROC (民國) year — e.g. 2026 → 115. */
const currentRocYear = () => Number(taipeiDateTime(new Date()).slice(0, 4)) - 1911;

/** provider-specific fields callers may pass via `input.providerOptions`. */
interface SimpanyProviderOptions {
  /** Simpany's INTERNAL receipt id (from an issue result's `raw.id`) — skips the lookup. */
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
 * ⚠️ UNVERIFIED: the five operations' endpoints, payloads and enums were compiled
 * by hand, are NOT from a published API, are NOT confirmed against a live
 * e-invoice-enabled account, and may be inaccurate. The auth layer
 * (`me` / `resolveCompanyId`) IS verified. Treat operation behaviour as
 * best-effort and file GitHub issues for any discrepancy.
 *
 * Operations run on the receipt host (`member2.simpany.co`) and are scoped to a
 * company id (from config or resolved via `/me`). void / query / allowance key
 * off Simpany's INTERNAL receipt id — pass an issue result's `raw.id` back via
 * `providerOptions.receiptId` to skip the (best-effort) invoice-number lookup.
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
    const cid = await this.resolveCompanyId();
    const receiptId = await this.resolveReceiptId(input.invoiceNumber, opts);
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
    const cid = await this.resolveCompanyId();
    const receiptId = await this.resolveReceiptId(input.invoiceNumber, opts);

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
    const cid = await this.resolveCompanyId();
    const receiptId = await this.resolveReceiptId(input.invoiceNumber, opts);
    const r = await this.client.receipt<Record<string, unknown>>(
      "GET",
      RECEIPT_ENDPOINTS.detail(cid, receiptId),
    );
    const total = Number(r.totalAmount ?? 0);
    const tax = Number(r.taxAmount ?? 0);
    const sales = r.salesAmount != null ? Number(r.salesAmount) : total - tax;
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
   * 發票列表 — list issued invoices (raw rows). The API REQUIRES `status` +
   * `startDate` + `endDate`, all three (verified live: anything less is a 422,
   * and `yearMonth` is not accepted) — they default to `status=ALL` over the
   * current Taipei calendar year. Override via `{ status, startDate, endDate,
   * page, limit }`. Read-only.
   */
  async listReceipts(
    query: Record<string, string | number> = {},
  ): Promise<Array<Record<string, unknown>>> {
    const cid = await this.resolveCompanyId();
    const year = taipeiDateTime(new Date()).slice(0, 4);
    const params = {
      status: "ALL",
      startDate: `${year}-01-01`,
      endDate: `${year}-12-31`,
      ...query,
    };
    const qs = new URLSearchParams(
      Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]),
    ).toString();
    const res = await this.client.receipt<unknown>("GET", `${RECEIPT_ENDPOINTS.list(cid)}?${qs}`);
    return toArray(res);
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
   * invoice to a corrected address. Pass `providerOptions.receiptId` (from an
   * issue result's `raw.id`) to skip the invoice-number lookup.
   */
  async notifyReceipt(
    invoiceNumber: string,
    emails: string[],
    opts: { receiptId?: string | number } = {},
  ): Promise<void> {
    const cid = await this.resolveCompanyId();
    const receiptId = await this.resolveReceiptId(invoiceNumber, { receiptId: opts.receiptId });
    await this.client.receipt("POST", RECEIPT_ENDPOINTS.notify(cid, receiptId), { emails });
  }

  /**
   * 下載發票證明聯 PDF — POST /c/{cid}/receipts/{id}/print. Returns the raw PDF
   * bytes + content type. `format` (e.g. `"FORMAT_A4"`) and `reprint` are passed
   * through; `reprint` marks it as a 補印本.
   */
  async printReceipt(
    invoiceNumber: string,
    opts: { receiptId?: string | number; format?: string; reprint?: boolean } = {},
  ): Promise<{ contentType: string; data: Uint8Array }> {
    const cid = await this.resolveCompanyId();
    const receiptId = await this.resolveReceiptId(invoiceNumber, { receiptId: opts.receiptId });
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

  /**
   * Resolve Simpany's internal receipt id: `providerOptions.receiptId` if given,
   * else a best-effort lookup by invoice number via the list `keyword` filter
   * (UNVERIFIED — the exact query param isn't confirmed; prefer passing receiptId).
   */
  private async resolveReceiptId(
    invoiceNumber: string | undefined,
    opts: SimpanyProviderOptions,
  ): Promise<string | number> {
    if (opts.receiptId != null) return opts.receiptId;
    if (!invoiceNumber) {
      throw fail("either invoiceNumber or providerOptions.receiptId is required");
    }
    const cid = await this.resolveCompanyId();
    const path = `${RECEIPT_ENDPOINTS.list(cid)}?keyword=${encodeURIComponent(invoiceNumber)}&limit=25`;
    const res = await this.client.receipt<unknown>("GET", path);
    const found = toArray(res).find((x) => String(x.invoiceNumber) === invoiceNumber)?.id;
    if (found == null) {
      throw new InvoiceError(`Simpany receipt ${invoiceNumber} not found`, {
        provider: "simpany",
        code: InvoiceErrorCode.NOT_FOUND,
        rawMessage: "receipt not found",
      });
    }
    return found as string | number;
  }
}

/** Create a Simpany {@link InvoiceProvider}. */
export function createSimpanyProvider(config: SimpanyConfig): SimpanyProvider {
  return new SimpanyProvider(config);
}
