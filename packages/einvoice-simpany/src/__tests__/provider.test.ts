import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Capability, PriceMode, TaxType, supports } from "@paid-tw/einvoice";
import { okLogin, okMe, rerror, rok, rurl, server, testProvider, url } from "./server.js";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const CID = 3432;
const login = () => http.post(url("/login"), () => okLogin());
const me = () =>
  http.get(url("/me"), () => okMe([{ id: CID, name: "Test Co", permissions: ["e_receipt"] }]));

const issueInput = (overrides = {}) => ({
  orderId: "ORD-1",
  buyer: { name: "買受人", email: "buyer@example.com" },
  items: [{ description: "商品A", quantity: 2, unitPrice: 50, amount: 100 }],
  amount: { salesAmount: 100, taxAmount: 5, totalAmount: 105 },
  taxType: TaxType.TAXABLE,
  priceMode: PriceMode.TAX_EXCLUSIVE,
  ...overrides,
});

describe("capabilities", () => {
  it("declares the five core operations + B2B, not MIXED_TAX / FOREIGN_CURRENCY", () => {
    const p = testProvider();
    expect(p.name).toBe("simpany");
    for (const c of [
      Capability.ISSUE,
      Capability.VOID,
      Capability.ALLOWANCE,
      Capability.VOID_ALLOWANCE,
      Capability.QUERY,
      Capability.B2B,
    ]) {
      expect(supports(p, c)).toBe(true);
    }
    expect(supports(p, Capability.MIXED_TAX)).toBe(false);
    expect(supports(p, Capability.FOREIGN_CURRENCY)).toBe(false);
  });
});

describe("issue", () => {
  it("posts to /receipts/b2c for an anonymous buyer and maps the result", async () => {
    let body: any;
    server.use(
      login(),
      me(),
      http.post(rurl(`/c/${CID}/receipts/b2c`), async ({ request }) => {
        body = await request.json();
        return rok({
          id: 900,
          invoiceNumber: "AB12345678",
          randomNumber: "4321",
          issuedAt: "2026-08-05 10:00:00",
          totalAmount: 105,
          status: "ISSUED",
        });
      }),
    );
    const res = await testProvider().issue(issueInput());
    expect(body.customId).toBe("ORD-1");
    expect(body.taxType).toBe("TAXABLE");
    expect(body.isTaxIncluded).toBe(false);
    expect(body.customer).toEqual({
      name: "買受人",
      address: undefined,
      emails: ["buyer@example.com"],
    });
    expect(body.items[0]).toMatchObject({ name: "商品A", quantity: 2, price: 50, subTotal: 100 });
    expect(body.items[0].uuid).toBeTruthy();
    expect(res.invoiceNumber).toBe("AB12345678");
    expect(res.randomCode).toBe("4321");
    expect(res.orderId).toBe("ORD-1");
    expect(res.status).toBe("ISSUED");
  });

  it("posts to /receipts/b2b and includes the buyer vat when a ubn is present", async () => {
    let body: any;
    server.use(
      login(),
      me(),
      http.post(rurl(`/c/${CID}/receipts/b2b`), async ({ request }) => {
        body = await request.json();
        return rok({
          id: 1,
          invoiceNumber: "AB1",
          randomNumber: "0001",
          issuedAt: "2026-08-05 10:00:00",
        });
      }),
    );
    await testProvider().issue(
      issueInput({ buyer: { name: "買方公司", ubn: "22099131", email: "b@e.com" } }),
    );
    expect(body.customer.vat).toBe("22099131");
  });

  it("maps a business error to a VALIDATION InvoiceError", async () => {
    server.use(
      login(),
      me(),
      http.post(rurl(`/c/${CID}/receipts/b2c`), () => rerror("發票內容有誤")),
    );
    await expect(testProvider().issue(issueInput())).rejects.toMatchObject({
      code: "VALIDATION",
      provider: "simpany",
    });
  });
});

describe("void", () => {
  it("DELETEs the receipt by receiptId with reason + emails", async () => {
    let body: any;
    server.use(
      login(),
      me(),
      http.delete(rurl(`/c/${CID}/receipts/900`), async ({ request }) => {
        body = await request.json();
        return rok({ id: 900, status: "INVALID" });
      }),
    );
    const res = await testProvider().void({
      invoiceNumber: "AB12345678",
      reason: "開錯",
      providerOptions: { receiptId: 900, emails: ["x@e.com"] },
    });
    expect(body).toEqual({ reason: "開錯", emails: ["x@e.com"] });
    expect(res.status).toBe("VOIDED");
  });

  it("looks up the receiptId by invoice number when not supplied", async () => {
    server.use(
      login(),
      me(),
      http.get(rurl(`/c/${CID}/receipts`), () => rok([{ id: 555, invoiceNumber: "AB99" }])),
      http.delete(rurl(`/c/${CID}/receipts/555`), () => rok({ id: 555 })),
    );
    const res = await testProvider().void({ invoiceNumber: "AB99", reason: "x" });
    expect(res.invoiceNumber).toBe("AB99");
  });
});

describe("allowance", () => {
  it("fetches line ids then POSTs a draft-allowance", async () => {
    let body: any;
    server.use(
      login(),
      me(),
      http.get(rurl(`/c/${CID}/receipts/900`), () =>
        rok({ id: 900, items: [{ id: 11 }, { id: 12 }] }),
      ),
      http.post(rurl(`/c/${CID}/receipts/900/draft-allowances`), async ({ request }) => {
        body = await request.json();
        return rok({ allowanceNumber: "ALW0001", issuedAt: "2026-08-05 11:00:00" });
      }),
    );
    const res = await testProvider().allowance({
      invoiceNumber: "AB12345678",
      allowanceId: "A-1",
      items: [{ description: "商品A", quantity: 1, unitPrice: 50, amount: 50 }],
      amount: { salesAmount: 48, taxAmount: 2, totalAmount: 50 },
      providerOptions: { receiptId: 900, emails: ["c@e.com"] },
    });
    expect(body.items).toEqual([{ id: 11, quantity: 1, price: 50 }]);
    expect(body.emails).toEqual(["c@e.com"]);
    expect(res.allowanceNumber).toBe("ALW0001");
  });

  it("accepts a raw items override via providerOptions", async () => {
    let body: any;
    server.use(
      login(),
      me(),
      http.post(rurl(`/c/${CID}/receipts/900/draft-allowances`), async ({ request }) => {
        body = await request.json();
        return rok({ allowanceNumber: "ALW2" });
      }),
    );
    await testProvider().allowance({
      invoiceNumber: "AB1",
      allowanceId: "A-2",
      items: [{ description: "x", quantity: 1, unitPrice: 10, amount: 10 }],
      amount: { salesAmount: 10, taxAmount: 0, totalAmount: 10 },
      providerOptions: { receiptId: 900, items: [{ id: 77, quantity: 1, price: 10 }] },
    });
    expect(body.items).toEqual([{ id: 77, quantity: 1, price: 10 }]);
  });
});

describe("voidAllowance", () => {
  it("requires providerOptions.allowanceId", async () => {
    await expect(
      testProvider().voidAllowance({ invoiceNumber: "AB1", allowanceNumber: "ALW1" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("DELETEs an issued allowance by id", async () => {
    let hit = false;
    server.use(
      login(),
      me(),
      http.delete(rurl(`/c/${CID}/allowances/321`), () => {
        hit = true;
        return rok({ id: 321 });
      }),
    );
    await testProvider().voidAllowance({
      invoiceNumber: "AB1",
      allowanceNumber: "ALW1",
      reason: "取消",
      providerOptions: { allowanceId: 321 },
    });
    expect(hit).toBe(true);
  });

  it("uses the draft endpoint when providerOptions.draft is set", async () => {
    let hit = false;
    server.use(
      login(),
      me(),
      http.delete(rurl(`/c/${CID}/draft-allowances/99`), () => {
        hit = true;
        return rok({ id: 99 });
      }),
    );
    await testProvider().voidAllowance({
      invoiceNumber: "AB1",
      allowanceNumber: "ALW1",
      providerOptions: { allowanceId: 99, draft: true },
    });
    expect(hit).toBe(true);
  });
});

describe("query", () => {
  it("GETs the receipt detail and maps it to the unified shape", async () => {
    server.use(
      login(),
      me(),
      http.get(rurl(`/c/${CID}/receipts/900`), () =>
        rok({
          id: 900,
          invoiceNumber: "AB12345678",
          randomNumber: "4321",
          issuedAt: "2026-08-05 10:00:00",
          status: "ISSUED",
          type: "B2B",
          customId: "ORD-1",
          totalAmount: 105,
          taxAmount: 5,
          buyerName: "買方",
          buyerVat: "12345678",
          buyerEmails: ["b@e.com"],
          items: [{ id: 11, name: "商品A", quantity: 2, price: 50, amount: 100 }],
        }),
      ),
    );
    const res = await testProvider().query({
      invoiceNumber: "AB12345678",
      providerOptions: { receiptId: 900 },
    });
    expect(res.invoiceNumber).toBe("AB12345678");
    expect(res.status).toBe("ISSUED");
    expect(res.amount).toEqual({ salesAmount: 100, taxAmount: 5, totalAmount: 105 });
    expect(res.buyer).toMatchObject({ name: "買方", ubn: "12345678", email: "b@e.com" });
    expect(res.items[0]).toMatchObject({
      description: "商品A",
      quantity: 2,
      unitPrice: 50,
      amount: 100,
    });
  });

  it("throws NOT_FOUND when the invoice-number lookup finds nothing", async () => {
    server.use(
      login(),
      me(),
      http.get(rurl(`/c/${CID}/receipts`), () => rok([])),
    );
    await expect(testProvider().query({ invoiceNumber: "NOPE" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("resolveCompanyId", () => {
  it("returns config.companyId without calling /me", async () => {
    expect(await testProvider({ companyId: 999 }).resolveCompanyId()).toBe(999);
  });

  it("resolves the sole company from /me", async () => {
    server.use(login(), me());
    expect(await testProvider().resolveCompanyId()).toBe(CID);
  });

  it("matches companyUbn when several companies exist", async () => {
    server.use(
      login(),
      http.get(url("/me"), () =>
        okMe([
          { id: 1, name: "A", ubn: "11111111" },
          { id: 2, name: "B", ubn: "22222222" },
        ]),
      ),
    );
    expect(await testProvider({ companyUbn: "22222222" }).resolveCompanyId()).toBe(2);
  });

  it("throws VALIDATION when the company is ambiguous", async () => {
    server.use(
      login(),
      http.get(url("/me"), () =>
        okMe([
          { id: 1, name: "A" },
          { id: 2, name: "B" },
        ]),
      ),
    );
    await expect(testProvider().resolveCompanyId()).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
