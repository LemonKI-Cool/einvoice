import { describe, expect, it } from "vitest";
import { CarrierType, InvoiceStatus, TaxType } from "@paid-tw/einvoice";
import {
  buyerEmails,
  simpanyCarrier,
  simpanyTaxType,
  toInvoiceStatus,
  toIssueItem,
} from "./mapping.js";

describe("simpanyTaxType", () => {
  it.each([
    [TaxType.TAXABLE, "TAXABLE"],
    [TaxType.SPECIAL, "TAXABLE"],
    [TaxType.ZERO_RATED, "ZERO_TAX_RATE"],
    [TaxType.TAX_FREE, "EXEMPTION"],
  ])("%s → %s", (input, expected) => {
    expect(simpanyTaxType(input)).toBe(expected);
  });
});

describe("simpanyCarrier", () => {
  it("maps an absent carrier to NO_CARRIER", () => {
    expect(simpanyCarrier()).toEqual({ type: "NO_CARRIER", number: null });
  });

  it.each([
    [CarrierType.MOBILE_BARCODE, "MOBILE_BARCODE"],
    [CarrierType.CITIZEN_CERTIFICATE, "CITIZEN_DIGITAL_CERTIFICATE"],
    [CarrierType.MEMBER, "MEMBERSHIP"],
  ])("%s → %s (keeps the code)", (type, expected) => {
    expect(simpanyCarrier({ type, code: "X" })).toEqual({ type: expected, number: "X" });
  });

  it("defaults a missing code to null", () => {
    expect(simpanyCarrier({ type: CarrierType.MEMBER }).number).toBeNull();
  });
});

describe("buyerEmails", () => {
  it("wraps a present email, else empty", () => {
    expect(buyerEmails({ email: "a@e.com" })).toEqual(["a@e.com"]);
    expect(buyerEmails({})).toEqual([]);
  });
});

describe("toIssueItem", () => {
  it("maps a unified item to the wire line with a uuid", () => {
    const line = toIssueItem({ description: "A", quantity: 2, unitPrice: 50, amount: 100 });
    expect(line).toMatchObject({ name: "A", quantity: 2, price: 50, subTotal: 100 });
    expect(typeof line.uuid).toBe("string");
    expect(line.uuid.length).toBeGreaterThan(0);
  });
});

describe("toInvoiceStatus", () => {
  it.each([
    ["ISSUED", InvoiceStatus.ISSUED],
    ["DRAFT", InvoiceStatus.ISSUED],
    ["INVALID", InvoiceStatus.VOIDED],
    ["CANCELED", InvoiceStatus.VOIDED],
    ["EXPIRED", InvoiceStatus.ALLOWANCE],
    ["something-else", InvoiceStatus.ISSUED],
    [undefined, InvoiceStatus.ISSUED],
  ])("%s → %s", (input, expected) => {
    expect(toInvoiceStatus(input)).toBe(expected);
  });
});
