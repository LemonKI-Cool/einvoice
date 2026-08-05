import { randomUUID } from "node:crypto";
import {
  CarrierType,
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

export const SIMPANY_STATUS = {
  DRAFT: "DRAFT",
  ISSUED: "ISSUED",
  INVALID: "INVALID",
  CANCELED: "CANCELED",
  EXPIRED: "EXPIRED",
} as const;

/** Unified {@link TaxType} → Simpany `taxType`. SPECIAL issues as TAXABLE. */
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

/** Simpany `status` → unified {@link InvoiceStatus}. */
export function toInvoiceStatus(status: unknown): InvoiceStatus {
  const s = String(status ?? "").toUpperCase();
  if (s === SIMPANY_STATUS.INVALID || s === SIMPANY_STATUS.CANCELED) return InvoiceStatus.VOIDED;
  if (s === SIMPANY_STATUS.EXPIRED) return InvoiceStatus.ALLOWANCE;
  return InvoiceStatus.ISSUED;
}
