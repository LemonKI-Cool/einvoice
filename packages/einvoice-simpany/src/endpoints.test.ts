import { describe, expect, it } from "vitest";
import { AUTH_ENDPOINTS, RECEIPT_ENDPOINTS } from "./endpoints.js";

const c = 3432;
const id = 900;

describe("AUTH_ENDPOINTS", () => {
  it("are the expected auth paths", () => {
    expect(AUTH_ENDPOINTS.login).toBe("/login");
    expect(AUTH_ENDPOINTS.me).toBe("/me");
  });
});

describe("RECEIPT_ENDPOINTS builders", () => {
  it("build the expected company-scoped paths", () => {
    expect(RECEIPT_ENDPOINTS.issue(c, "B2C")).toBe(`/c/${c}/receipts/b2c`);
    expect(RECEIPT_ENDPOINTS.issue(c, "B2B")).toBe(`/c/${c}/receipts/b2b`);
    expect(RECEIPT_ENDPOINTS.list(c)).toBe(`/c/${c}/receipts`);
    expect(RECEIPT_ENDPOINTS.detail(c, id)).toBe(`/c/${c}/receipts/${id}`);
    expect(RECEIPT_ENDPOINTS.void(c, id)).toBe(`/c/${c}/receipts/${id}`);
    expect(RECEIPT_ENDPOINTS.issueAllowance(c, id)).toBe(`/c/${c}/receipts/${id}/draft-allowances`);
    expect(RECEIPT_ENDPOINTS.voidAllowance(c, id)).toBe(`/c/${c}/allowances/${id}`);
    expect(RECEIPT_ENDPOINTS.voidDraftAllowance(c, id)).toBe(`/c/${c}/draft-allowances/${id}`);
    expect(RECEIPT_ENDPOINTS.allowanceList(c)).toBe(`/c/${c}/allowances`);
    expect(RECEIPT_ENDPOINTS.allowanceDetail(c, id)).toBe(`/c/${c}/allowances/${id}`);
    expect(RECEIPT_ENDPOINTS.notify(c, id)).toBe(`/c/${c}/receipts/${id}/notifications`);
    expect(RECEIPT_ENDPOINTS.notifyAllowance(c, id)).toBe(`/c/${c}/allowances/${id}/notifications`);
    expect(RECEIPT_ENDPOINTS.print(c, id)).toBe(`/c/${c}/receipts/${id}/print`);
    expect(RECEIPT_ENDPOINTS.printAllowance(c, id)).toBe(`/c/${c}/allowances/${id}/print`);
    expect(RECEIPT_ENDPOINTS.batches(c)).toBe(`/c/${c}/receipts/batches`);
    expect(RECEIPT_ENDPOINTS.batchValidation(c)).toBe(`/c/${c}/receipts/batches/validation`);
    expect(RECEIPT_ENDPOINTS.batchDownload(c, 7)).toBe(`/c/${c}/receipts/batches/7/download`);
    expect(RECEIPT_ENDPOINTS.export(c)).toBe(`/c/${c}/receipts/export`);
    expect(RECEIPT_ENDPOINTS.winning(c, "2026-07")).toBe(`/c/${c}/winning-receipts/2026-07`);
    expect(RECEIPT_ENDPOINTS.zeroTaxReasons(c)).toBe(`/c/${c}/receipts/zero-tax-rate-reasons`);
  });
});
