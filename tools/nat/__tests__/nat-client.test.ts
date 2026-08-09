import { describe, expect, test } from "bun:test";
import { NatClient } from "../nat-client.ts";

describe("NatClient.parseNatCsv", () => {
  test("preserves quoted commas, escaped quotes, and multiline fields", () => {
    const csv = [
      "M,發票號碼,買方統一編號,賣方統一編號,課稅別,總備註",
      "D,發票號碼,品名,單一欄位備註",
      'M,AB12345678,12345678,87654321,應稅,"first line\nsecond line"',
      'D,AB12345678,"顧問服務,進階方案","customer said ""ok"""',
      "",
    ].join("\r\n");

    const invoices = NatClient.parseNatCsv(new TextEncoder().encode(csv));

    expect(invoices).toHaveLength(1);
    expect(invoices[0]["課稅別"]).toBe("應稅");
    expect(invoices[0]["總備註"]).toBe("first line\nsecond line");
    expect(invoices[0].items).toEqual([
      { 發票號碼: "AB12345678", 品名: "顧問服務,進階方案", 單一欄位備註: 'customer said "ok"' },
    ]);
  });
});
