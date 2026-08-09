import { describe, expect, spyOn, test } from "bun:test";
import { dedupeNatInvoices, NatClient, type NatInvoice } from "../nat-client.ts";

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

  test("repairs an unquoted comma in the portal's buyer-name field", () => {
    const csv = [
      "M,發票號碼,買方名稱,賣方統一編號,寄送日期,課稅別",
      "D,發票號碼,品名",
      "M,AB12345678,測試,分店,12345678,2026-01-02 03:04:05,應稅",
      "D,AB12345678,服務費",
      "",
    ].join("\r\n");

    const [invoice] = NatClient.parseNatCsv(new TextEncoder().encode(csv));

    expect(invoice["買方名稱"]).toBe("測試,分店");
    expect(invoice["賣方統一編號"]).toBe("12345678");
    expect(invoice["寄送日期"]).toBe("2026-01-02 03:04:05");
    expect(invoice["課稅別"]).toBe("應稅");
  });
});

describe("dedupeNatInvoices", () => {
  const invoice = (total: string): NatInvoice => ({
    發票號碼: "AB12345678",
    賣方統一編號: "12345678",
    總計: total,
    items: [{ 品名: "測試品項" }],
  });

  test("removes an exact portal overlap", () => {
    expect(dedupeNatInvoices([invoice("100"), invoice("100")])).toHaveLength(1);
  });

  test("keeps the first row and warns on conflicting content under the same key", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const deduped = dedupeNatInvoices([invoice("100"), invoice("200")]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]["總計"]).toBe("100");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
