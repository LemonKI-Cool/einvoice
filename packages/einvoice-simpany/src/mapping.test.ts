import { describe, expect, it } from "vitest";
import { CarrierType, InvoiceStatus, TaxType } from "@paid-tw/einvoice";
import {
  buyerEmails,
  simpanyCarrier,
  simpanyTaxType,
  toInvoiceStatus,
  toIssueItem,
  trackUsage,
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

describe("trackUsage", () => {
  it("prefers the API's remainingQuantity (a real masked row, digit-string numbers)", () => {
    expect(
      trackUsage({
        beginNumber: "12345000",
        endNumber: "12345199",
        lastUsedNumber: "12345000",
        remainingQuantity: 199,
      }),
    ).toEqual({ total: 200, used: 1, remaining: 199 });
  });

  it("clamps a negative remainingQuantity", () => {
    expect(trackUsage({ beginNumber: 0, endNumber: 49, remainingQuantity: -1 })).toEqual({
      total: 50,
      used: 50,
      remaining: 0,
    });
  });

  it("falls back to counting begin…lastUsed without remainingQuantity", () => {
    expect(trackUsage({ beginNumber: 0, endNumber: 49, lastUsedNumber: 9 })).toEqual({
      total: 50,
      used: 10,
      remaining: 40,
    });
  });

  it("counts an untouched track as nothing issued (lastUsedNumber is null, verified live)", () => {
    expect(
      trackUsage({ beginNumber: "67890000", endNumber: "67890199", lastUsedNumber: null }),
    ).toEqual({ total: 200, used: 0, remaining: 200 });
  });

  it("counts a track whose lastUsedNumber equals beginNumber as one issued", () => {
    expect(
      trackUsage({ beginNumber: "12345000", endNumber: "12345199", lastUsedNumber: "12345000" }),
    ).toEqual({ total: 200, used: 1, remaining: 199 });
  });

  it("treats an empty lastUsedNumber as nothing issued", () => {
    expect(trackUsage({ beginNumber: 0, endNumber: 49, lastUsedNumber: "" })).toEqual({
      total: 50,
      used: 0,
      remaining: 50,
    });
  });

  it("handles a missing/garbage row without throwing", () => {
    expect(trackUsage({})).toEqual({ total: 0, used: 0, remaining: 0 });
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
