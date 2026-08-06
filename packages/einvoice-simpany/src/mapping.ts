import { randomUUID } from "node:crypto";
import {
  CarrierType,
  InvoiceError,
  InvoiceErrorCode,
  InvoiceStatus,
  type Buyer,
  type Carrier,
  type InvoiceItem,
  type TaxType,
} from "@paid-tw/einvoice";

/**
 * Simpany's e-invoice enums (compiled by hand; may be incomplete). Exported so
 * callers can pass the exact wire values via `providerOptions` when the unified
 * model doesn't cover a field (e.g. `zeroTaxRateReasonCode`, `customsClearanceType`).
 */
export const SIMPANY_TAX_TYPE = {
  TAXABLE: "TAXABLE",
  ZERO_TAX_RATE: "ZERO_TAX_RATE",
  EXEMPTION: "EXEMPTION",
} as const;

export const SIMPANY_CARRIER_TYPE = {
  NO_CARRIER: "NO_CARRIER",
  MOBILE_BARCODE: "MOBILE_BARCODE",
  CITIZEN_DIGITAL_CERTIFICATE: "CITIZEN_DIGITAL_CERTIFICATE",
  MEMBERSHIP: "MEMBERSHIP",
} as const;

/**
 * A 字軌 row's `status` — a different enum from a receipt's {@link SIMPANY_STATUS}.
 * Both values are VERIFIED live (PR #5).
 *
 * ⚠️ An `EXPIRED` track KEEPS its `remainingQuantity`: a period's unused numbers
 * simply lapse, so a track can report 200 remaining and be worth nothing. Any
 * capacity arithmetic must count `ENABLED` tracks only.
 */
export const SIMPANY_TRACK_STATUS = {
  ENABLED: "ENABLED",
  EXPIRED: "EXPIRED",
} as const;

export const SIMPANY_STATUS = {
  DRAFT: "DRAFT",
  ISSUED: "ISSUED",
  INVALID: "INVALID",
  CANCELED: "CANCELED",
  EXPIRED: "EXPIRED",
} as const;

/**
 * Unified {@link TaxType} → Simpany `taxType`. SPECIAL has no Simpany member and
 * is rejected upstream (UNSUPPORTED) before this map runs; it only degrades to
 * TAXABLE here on the `validatePayload:false` escape hatch.
 */
export function simpanyTaxType(taxType: TaxType): string {
  switch (taxType) {
    case "ZERO_RATED":
      return SIMPANY_TAX_TYPE.ZERO_TAX_RATE;
    case "TAX_FREE":
      return SIMPANY_TAX_TYPE.EXEMPTION;
    default:
      return SIMPANY_TAX_TYPE.TAXABLE; // TAXABLE + SPECIAL
  }
}

/** Unified {@link Carrier} → Simpany `{ type, number }`. Absent carrier → NO_CARRIER. */
export function simpanyCarrier(carrier?: Carrier): { type: string; number: string | null } {
  if (!carrier) return { type: SIMPANY_CARRIER_TYPE.NO_CARRIER, number: null };
  const type =
    carrier.type === CarrierType.MOBILE_BARCODE
      ? SIMPANY_CARRIER_TYPE.MOBILE_BARCODE
      : carrier.type === CarrierType.CITIZEN_CERTIFICATE
        ? SIMPANY_CARRIER_TYPE.CITIZEN_DIGITAL_CERTIFICATE
        : SIMPANY_CARRIER_TYPE.MEMBERSHIP;
  return { type, number: carrier.code ?? null };
}

/** Map a buyer's emails to Simpany's `emails` array. */
export function buyerEmails(buyer: Buyer): string[] {
  return buyer.email ? [buyer.email] : [];
}

/** Unified {@link InvoiceItem} → Simpany issue line `{ uuid, name, quantity, price, subTotal }`. */
export function toIssueItem(item: InvoiceItem): {
  uuid: string;
  name: string;
  quantity: number;
  price: number;
  subTotal: number;
} {
  return {
    uuid: randomUUID(),
    name: item.description,
    quantity: item.quantity,
    price: item.unitPrice,
    subTotal: item.amount,
  };
}

/** Computed usage of one 字軌 (invoice-number track). */
export interface TrackNumberUsage {
  /** Total numbers in the track. */
  total: number;
  /** How many have been issued (begin … lastUsedNumber). */
  used: number;
  /** total − used. */
  remaining: number;
}

/**
 * Usage of one 字軌 row (field names VERIFIED live — see PR #5; `beginNumber` /
 * `endNumber` / `lastUsedNumber` arrive as digit strings). `total` is
 * `endNumber − beginNumber + 1`; `remaining` prefers the API's own authoritative
 * `remainingQuantity`, with `used = total − remaining`. Only without
 * `remainingQuantity` does it fall back to counting `beginNumber … lastUsedNumber`
 * — which is exact: an untouched track reports `lastUsedNumber: null` (not
 * `beginNumber`), so the fallback yields `used: 0` rather than overcounting by 1.
 */
export function trackUsage(row: Record<string, unknown>): TrackNumberUsage {
  const num = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const begin = num(row.beginNumber);
  const end = num(row.endNumber);
  const last = num(row.lastUsedNumber);
  const total = begin != null && end != null ? end - begin + 1 : 0;
  const remainingApi = num(row.remainingQuantity);
  if (remainingApi != null) {
    const remaining = Math.max(0, remainingApi);
    return { total, used: Math.max(0, total - remaining), remaining };
  }
  const used = last != null && begin != null ? Math.max(0, last - begin + 1) : 0;
  return { total, used, remaining: Math.max(0, total - used) };
}

/**
 * Simpany `status` → unified {@link InvoiceStatus}. Only states with a faithful
 * unified equivalent are mapped; `DRAFT`, `EXPIRED` and unrecognised values
 * throw (PROVIDER) rather than being reported as legally ISSUED — the wire
 * value stays readable via `rawCode` and the response's `raw.status`.
 * {@link InvoiceStatus.ALLOWANCE} is never derived here: it comes from the
 * detail's `allowances` rows in `query` (see {@link hasActiveAllowance}).
 */
export function toInvoiceStatus(status: unknown): InvoiceStatus {
  const s = String(status ?? "").toUpperCase();
  if (s === SIMPANY_STATUS.ISSUED) return InvoiceStatus.ISSUED;
  if (s === SIMPANY_STATUS.INVALID || s === SIMPANY_STATUS.CANCELED) return InvoiceStatus.VOIDED;
  throw new InvoiceError(
    `Simpany receipt status "${s}" has no unified InvoiceStatus equivalent — read raw.status`,
    {
      provider: "simpany",
      code: InvoiceErrorCode.PROVIDER,
      rawCode: s || undefined,
      rawMessage: `unmapped receipt status ${s}`,
    },
  );
}

/**
 * Whether a receipt detail's `allowances` rows include one still in force.
 * A row is discounted when it carries a void mark — `invalidatedAt`, or an
 * INVALID / CANCELED status; anything else counts as active.
 */
export function hasActiveAllowance(allowances: unknown): boolean {
  if (!Array.isArray(allowances)) return false;
  return allowances.some((entry) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    const s = String(row.status ?? "").toUpperCase();
    if (s === SIMPANY_STATUS.INVALID || s === SIMPANY_STATUS.CANCELED) return false;
    return row.invalidatedAt == null;
  });
}
