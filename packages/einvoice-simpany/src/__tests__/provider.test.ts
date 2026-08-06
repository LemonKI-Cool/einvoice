import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  Capability,
  CarrierType,
  PriceMode,
  TaxType,
  supports,
  taipeiDateTime,
} from "@paid-tw/einvoice";
import { defaultListWindow, exceedsMonthSpan } from "../dates.js";
import { okLogin, okMe, rerror, rok, rpdf, rurl, server, testProvider, url } from "./server.js";

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
          issuedAt: "2026-08-05T10:00:00+08:00",
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
    // issuedAt is ISO8601 with a +08:00 offset (verified live).
    expect(res.invoiceDate.toISOString()).toBe("2026-08-05T02:00:00.000Z");
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
          randomNumber: null, // B2B invoices carry no random code (verified live)
          issuedAt: "2026-08-05T10:00:00+08:00",
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

describe("issue validation (local pre-flight)", () => {
  it("requires buyer.email", async () => {
    await expect(
      testProvider().issue(issueInput({ buyer: { name: "買受人" } })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("requires buyer.name for B2B", async () => {
    await expect(
      testProvider().issue(issueInput({ buyer: { ubn: "22099131", email: "b@e.com" } })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects an item quantity above 999999", async () => {
    await expect(
      testProvider().issue(
        issueInput({ items: [{ description: "x", quantity: 1_000_000, unitPrice: 1, amount: 1 }] }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects a unitPrice above 99999999", async () => {
    await expect(
      testProvider().issue(
        issueInput({
          items: [{ description: "x", quantity: 1, unitPrice: 100_000_000, amount: 100_000_000 }],
          amount: { salesAmount: 100_000_000, taxAmount: 0, totalAmount: 100_000_000 },
        }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("requires zeroTaxRateReasonCode for a zero-rated invoice", async () => {
    await expect(
      testProvider().issue(
        issueInput({
          taxType: TaxType.ZERO_RATED,
          amount: { salesAmount: 100, taxAmount: 0, totalAmount: 100 },
        }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects a malformed citizen-certificate carrier code", async () => {
    await expect(
      testProvider().issue(
        issueInput({ carrier: { type: CarrierType.CITIZEN_CERTIFICATE, code: "BAD" } }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("bypasses local validation when validatePayload is false", async () => {
    let hit = false;
    server.use(
      login(),
      http.post(rurl(`/c/${CID}/receipts/b2c`), () => {
        hit = true;
        return rok({
          id: 1,
          invoiceNumber: "AB1",
          randomNumber: "0001",
          issuedAt: "2026-08-05 10:00:00",
        });
      }),
    );
    // Missing email would normally fail — but validatePayload:false skips the check.
    await testProvider({ companyId: CID, validatePayload: false }).issue(
      issueInput({ buyer: { name: "買受人" } }),
    );
    expect(hit).toBe(true);
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

  it("throws VALIDATION without providerOptions.receiptId (no invoice-number lookup)", async () => {
    await expect(testProvider().void({ invoiceNumber: "AB99", reason: "x" })).rejects.toMatchObject(
      { code: "VALIDATION", message: expect.stringContaining("receiptId") },
    );
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
        return rok({ allowanceNumber: "ALW0001", issuedAt: "2026-08-05T11:00:00+08:00" });
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

  it("throws VALIDATION when an item can't be matched to an invoice line", async () => {
    server.use(
      login(),
      me(),
      http.get(rurl(`/c/${CID}/receipts/900`), () => rok({ id: 900, items: [] })),
    );
    await expect(
      testProvider().allowance({
        invoiceNumber: "AB1",
        allowanceId: "A-3",
        items: [{ description: "x", quantity: 1, unitPrice: 10, amount: 10 }],
        amount: { salesAmount: 10, taxAmount: 0, totalAmount: 10 },
        providerOptions: { receiptId: 900 },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
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
  it("GETs the receipt detail and maps the verified response shape", async () => {
    server.use(
      login(),
      me(),
      // The field set a live B2B detail actually returns (masked; see PR #5).
      http.get(rurl(`/c/${CID}/receipts/900`), () =>
        rok({
          id: 900,
          customId: "ORD-1",
          type: "B2B",
          status: "ISSUED",
          uploadStatus: "COMPLETED",
          printStatus: "NOT_PRINTED",
          invoiceNumber: "AB12345678",
          randomNumber: null, // null on B2B (verified live)
          buyerVat: "12345678",
          buyerName: "買方",
          buyerAddress: null,
          buyerEmails: ["b@e.com"],
          taxType: "TAXABLE",
          customsClearanceType: "BLANK",
          zeroTaxRateReason: null,
          taxRate: 5,
          isTaxIncluded: false,
          isTaxAmountAdjusted: false,
          taxAmount: 5,
          untaxedAmount: 100,
          totalAmount: 105,
          remainingAmount: 105,
          remark: "",
          carrierType: "NO_CARRIER",
          carrierNumber: null,
          npoBan: null,
          invalidReason: null,
          issuedAt: "2026-08-05T10:00:00+08:00",
          invalidatedAt: null,
          canInvalidate: true,
          canIssueAllowance: true,
          canPrint: true,
          items: [{ id: "11", name: "商品A", quantity: 2, price: 50, amount: 100 }],
          allowances: [],
          emailHistories: [],
        }),
      ),
    );
    const res = await testProvider().query({
      invoiceNumber: "AB12345678",
      providerOptions: { receiptId: 900 },
    });
    expect(res.invoiceNumber).toBe("AB12345678");
    expect(res.status).toBe("ISSUED");
    expect(res.randomCode).toBe("");
    expect(res.invoiceDate.toISOString()).toBe("2026-08-05T02:00:00.000Z");
    expect(res.amount).toEqual({ salesAmount: 100, taxAmount: 5, totalAmount: 105 });
    expect(res.buyer).toMatchObject({ name: "買方", ubn: "12345678", email: "b@e.com" });
    expect(res.items[0]).toMatchObject({
      description: "商品A",
      quantity: 2,
      unitPrice: 50,
      amount: 100,
    });
    expect(res.raw).toMatchObject({ canInvalidate: true, uploadStatus: "COMPLETED" });
  });

  it("throws VALIDATION without providerOptions.receiptId (no invoice-number lookup)", async () => {
    await expect(testProvider().query({ invoiceNumber: "NOPE" })).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining("receiptId"),
    });
  });
});

describe("read-only helpers", () => {
  it("listReceipts defaults the REQUIRED status/startDate/endDate and forwards extras", async () => {
    let seen: URL | undefined;
    server.use(
      login(),
      me(),
      http.get(rurl(`/c/${CID}/receipts`), ({ request }) => {
        seen = new URL(request.url);
        // A list body that is NOT unwrapped to a bare array (no top-level `data`).
        return HttpResponse.json({ list: [{ id: 1, invoiceNumber: "AB1" }] });
      }),
    );
    const rows = await testProvider().listReceipts({ limit: 5 });
    expect(rows).toHaveLength(1);
    expect(seen?.searchParams.get("status")).toBe("ALL");
    expect(seen?.searchParams.get("limit")).toBe("5");

    // The default is the rolling window, and above all one the API accepts.
    const expected = defaultListWindow();
    expect(seen?.searchParams.get("startDate")).toBe(expected.startDate);
    expect(seen?.searchParams.get("endDate")).toBe(expected.endDate);
    expect(exceedsMonthSpan(expected.startDate, expected.endDate)).toBe(false);
  });

  it("listReceipts still covers last December when called in early January", async () => {
    let seen: URL | undefined;
    server.use(
      login(),
      me(),
      http.get(rurl(`/c/${CID}/receipts`), ({ request }) => {
        seen = new URL(request.url);
        return rok([]);
      }),
    );
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-05T12:00:00+08:00"));
      await testProvider().listReceipts();
    } finally {
      vi.useRealTimers();
    }
    expect(seen?.searchParams.get("startDate")).toBe("2025-01-06");
    expect(seen?.searchParams.get("endDate")).toBe("2026-01-05");
  });

  it("listReceipts anchors the default window to a caller-supplied endDate", async () => {
    let seen: URL | undefined;
    server.use(
      login(),
      me(),
      http.get(rurl(`/c/${CID}/receipts`), ({ request }) => {
        seen = new URL(request.url);
        return rok([]);
      }),
    );
    await testProvider().listReceipts({ endDate: "2024-06-30" });
    expect(seen?.searchParams.get("startDate")).toBe("2023-07-01");
    expect(seen?.searchParams.get("endDate")).toBe("2024-06-30");
  });

  it("listReceipts rejects a window longer than the API's limit before requesting", async () => {
    // No MSW handler: reaching the network at all would fail the test.
    server.use(login(), me());
    await expect(
      testProvider().listReceipts({ startDate: "2020-01-01", endDate: "2026-08-07" }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining("simpanyListWindows"),
    });
  });

  it("listReceipts catches a too-long window formed by defaulting the other end", async () => {
    server.use(login(), me());
    await expect(testProvider().listReceipts({ startDate: "2015-01-01" })).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining("12-month"),
    });
  });

  it("listReceipts rejects a reversed or malformed range", async () => {
    server.use(login(), me());
    await expect(
      testProvider().listReceipts({ startDate: "2026-08-07", endDate: "2026-01-01" }),
    ).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("is after") });
    await expect(testProvider().listReceipts({ endDate: "2026/08/07" })).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining("YYYY-MM-DD"),
    });
  });

  it("listReceipts lets callers override the defaulted params", async () => {
    let seen: URL | undefined;
    server.use(
      login(),
      me(),
      http.get(rurl(`/c/${CID}/receipts`), ({ request }) => {
        seen = new URL(request.url);
        return rok([]);
      }),
    );
    await testProvider().listReceipts({
      status: "ISSUED",
      startDate: "2026-01-01",
      endDate: "2026-06-30",
    });
    expect(seen?.searchParams.get("status")).toBe("ISSUED");
    expect(seen?.searchParams.get("startDate")).toBe("2026-01-01");
    expect(seen?.searchParams.get("endDate")).toBe("2026-06-30");
  });

  it("listTrackNumbers sends the ROC year and maps a real (masked) track row", async () => {
    let seen: URL | undefined;
    server.use(
      login(),
      me(),
      http.get(rurl(`/c/${CID}/track-numbers`), ({ request }) => {
        seen = new URL(request.url);
        return rok([
          {
            id: 99999,
            year: 115,
            month: 8,
            type: "NORMAL",
            track: "AB",
            beginNumber: "12345000",
            endNumber: "12345199",
            lastUsedNumber: "12345000",
            remainingQuantity: 199,
            status: "ENABLED",
            canEnable: false,
            canDisable: true,
            canDelete: false,
            canSplit: false,
          },
        ]);
      }),
    );
    const tracks = await testProvider().listTrackNumbers({ year: 115 });
    expect(seen?.searchParams.get("year")).toBe("115");
    expect(tracks[0]).toMatchObject({
      year: 115,
      month: 8,
      track: "AB",
      total: 200,
      used: 1,
      remaining: 199,
    });
    expect(tracks[0]?.raw.id).toBe(99999);
  });

  it("listTrackNumbers defaults year to the current ROC year", async () => {
    let seen: URL | undefined;
    server.use(
      login(),
      me(),
      http.get(rurl(`/c/${CID}/track-numbers`), ({ request }) => {
        seen = new URL(request.url);
        return rok([]);
      }),
    );
    await testProvider().listTrackNumbers();
    const roc = Number(taipeiDateTime(new Date()).slice(0, 4)) - 1911;
    expect(seen?.searchParams.get("year")).toBe(String(roc));
  });

  it("listTrackNumbers rejects a Gregorian year (the API silently returns [] for one)", async () => {
    await expect(testProvider().listTrackNumbers({ year: 2026 })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("listTrackNumbers({ enabledOnly }) hits the enabled endpoint without a year", async () => {
    let seen: URL | undefined;
    server.use(
      login(),
      me(),
      http.get(rurl(`/c/${CID}/track-numbers/enabled`), ({ request }) => {
        seen = new URL(request.url);
        return rok([]);
      }),
    );
    await testProvider().listTrackNumbers({ enabledOnly: true });
    expect(seen).toBeDefined();
    expect(seen?.searchParams.has("year")).toBe(false);
  });
});

describe("notifyReceipt / printReceipt", () => {
  it("notifyReceipt POSTs the corrected emails to the notifications endpoint", async () => {
    let body: any;
    server.use(
      login(),
      me(),
      http.post(rurl(`/c/${CID}/receipts/900/notifications`), async ({ request }) => {
        body = await request.json();
        return rok({ ok: true });
      }),
    );
    await testProvider().notifyReceipt(900, ["fixed@example.com"]);
    expect(body).toEqual({ emails: ["fixed@example.com"] });
  });

  it("printReceipt returns the PDF bytes + content-type", async () => {
    server.use(
      login(),
      me(),
      http.post(rurl(`/c/${CID}/receipts/900/print`), () => rpdf([0x25, 0x50, 0x44, 0x46])),
    );
    const res = await testProvider().printReceipt(900, { format: "FORMAT_A4" });
    expect(res.contentType).toContain("application/pdf");
    expect(Array.from(res.data)).toEqual([0x25, 0x50, 0x44, 0x46]); // %PDF
  });
});

describe("subscription quota / frequent items", () => {
  it("getSubscriptionStatus returns status + remainingQuantity", async () => {
    server.use(
      login(),
      me(),
      http.get(rurl(`/c/${CID}/subscription-status`), () =>
        rok({ status: "ACTIVE", remainingQuantity: 123 }),
      ),
    );
    const s = await testProvider().getSubscriptionStatus();
    expect(s).toMatchObject({ status: "ACTIVE", remainingQuantity: 123 });
    expect(s.raw.remainingQuantity).toBe(123);
  });

  it("canIssue reports ok when both the plan quota and the tracks cover the count", async () => {
    server.use(
      login(),
      me(),
      http.get(rurl(`/c/${CID}/subscription-status`), () =>
        rok({ status: "ACTIVE", remainingQuantity: 50 }),
      ),
      http.get(rurl(`/c/${CID}/track-numbers/enabled`), () =>
        rok([
          { beginNumber: "12345000", endNumber: "12345199", remainingQuantity: 199 },
          { beginNumber: "67890000", endNumber: "67890099", remainingQuantity: 100 },
        ]),
      ),
    );
    const cap = await testProvider().canIssue(10);
    expect(cap).toMatchObject({
      ok: true,
      count: 10,
      bottleneck: undefined,
      subscriptionRemaining: 50,
      subscriptionStatus: "ACTIVE",
      trackRemaining: 299,
    });
    expect(cap.tracks).toHaveLength(2);
  });

  it("canIssue names the plan quota as the bottleneck when it is the tighter limit", async () => {
    server.use(
      login(),
      me(),
      http.get(rurl(`/c/${CID}/subscription-status`), () =>
        rok({ status: "ACTIVE", remainingQuantity: 3 }),
      ),
      http.get(rurl(`/c/${CID}/track-numbers/enabled`), () =>
        rok([{ beginNumber: "12345000", endNumber: "12345199", remainingQuantity: 199 }]),
      ),
    );
    expect(await testProvider().canIssue(10)).toMatchObject({
      ok: false,
      bottleneck: "SUBSCRIPTION",
      subscriptionRemaining: 3,
      trackRemaining: 199,
    });
  });

  it("canIssue names the tracks as the bottleneck when the numbers run out first", async () => {
    server.use(
      login(),
      me(),
      http.get(rurl(`/c/${CID}/subscription-status`), () =>
        rok({ status: "ACTIVE", remainingQuantity: 500 }),
      ),
      http.get(rurl(`/c/${CID}/track-numbers/enabled`), () =>
        rok([{ beginNumber: "12345000", endNumber: "12345199", remainingQuantity: 4 }]),
      ),
    );
    expect(await testProvider().canIssue(10)).toMatchObject({
      ok: false,
      bottleneck: "TRACK_NUMBER",
      trackRemaining: 4,
    });
  });

  it("canIssue defaults to a single invoice and treats no enabled track as zero", async () => {
    server.use(
      login(),
      me(),
      http.get(rurl(`/c/${CID}/subscription-status`), () =>
        rok({ status: "ACTIVE", remainingQuantity: 10 }),
      ),
      http.get(rurl(`/c/${CID}/track-numbers/enabled`), () => rok([])),
    );
    expect(await testProvider().canIssue()).toMatchObject({
      ok: false,
      count: 1,
      bottleneck: "TRACK_NUMBER",
      trackRemaining: 0,
    });
  });

  it("listFrequentItems returns the raw rows", async () => {
    server.use(
      login(),
      me(),
      http.get(rurl(`/c/${CID}/frequent-items`), () =>
        rok([{ id: 1, name: "諮詢費", price: 1000 }]),
      ),
    );
    const items = await testProvider().listFrequentItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "諮詢費", price: 1000 });
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
