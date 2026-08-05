# @paid-tw/einvoice-simpany

Simpany ([simpany.co](https://simpany.co/e-invoice)) adapter for
[@paid-tw/einvoice](../einvoice).

> ⚠️ **The five operations' details were compiled by hand, may be inaccurate, and
> are UNVERIFIED against the live API.** The auth layer (login / `me` / company
> resolution) is verified against production; but the issue / void / allowance /
> void-allowance / query endpoints, payloads and field names were put together by
> hand and have NOT been confirmed against a live e-invoice-enabled account. Treat
> them as a best-effort starting point and file GitHub issues for any discrepancy.
> The package is `private: true` and is not published until verified.
>
> Before using it, **please read the [Disclaimer](#disclaimer)** and confirm your
> usage complies with applicable regulations and Simpany's terms of service.

## API overview

Simpany publishes no developer API. The shape below was compiled by hand and may
be inaccurate:

- **Two hosts, one JWT:**
  - Auth/account: `https://api.simpany.co/v1/` (`POST /login`, `GET /me`) — verified.
  - E-invoice (internally "receipt"): `https://member2.simpany.co/api/v1/c/{companyId}/…` — unverified.
- `POST /v1/login { account, password }` → `{ data:{ id, token } }`; `token` is a
  ~30-day JWT that authorizes both hosts.

## Operations & endpoints (hand-compiled, UNVERIFIED)

| Unified op | HTTP | Endpoint (under the receipt base) |
|---|---|---|
| `issue` | POST | `/c/{cid}/receipts/{b2b\|b2c}` |
| `void` | DELETE | `/c/{cid}/receipts/{receiptId}`, body `{reason, emails}` |
| `allowance` | POST | `/c/{cid}/receipts/{receiptId}/draft-allowances`, body `{emails, items:[{id,quantity,price}]}` |
| `voidAllowance` | DELETE | `/c/{cid}/allowances/{id}` (or `/draft-allowances/{id}`) |
| `query` | GET | `/c/{cid}/receipts/{receiptId}` |

- **Internal id vs invoice number:** void / query / allowance key off Simpany's
  INTERNAL receipt id, not the 發票號碼. Pass an `issue` result's `raw.id` back via
  `providerOptions.receiptId` (most reliable); given only an invoice number, the
  adapter attempts a list `keyword` lookup (that query param is unverified).
- **voidAllowance** requires `providerOptions.allowanceId` (internal id); add
  `providerOptions.draft: true` when the allowance is still a DRAFT (待確認).
- **Capabilities:** ISSUE / VOID / ALLOWANCE / VOID_ALLOWANCE / QUERY / B2B.
  NOT supported: MIXED_TAX (tax type is invoice-level), FOREIGN_CURRENCY,
  CARRIER_VALIDATION (no such endpoint in the client).

## Usage

```ts
import { createSimpanyProvider } from "@paid-tw/einvoice-simpany";

const provider = createSimpanyProvider({
  account: process.env.SIMPANY_ACCOUNT!,
  password: process.env.SIMPANY_PASSWORD!,
  // companyId: 3432, // else resolved from /me (sole company, or by companyUbn)
});

const inv = await provider.issue({
  orderId: "ORD-1",
  buyer: { name: "買受人", email: "buyer@example.com" },
  items: [{ description: "商品A", quantity: 2, unitPrice: 50, amount: 100 }],
  amount: { salesAmount: 100, taxAmount: 5, totalAmount: 105 },
  taxType: "TAXABLE",
  priceMode: "TAX_EXCLUSIVE",
});

const receiptId = (inv.raw as { id: number }).id;
await provider.query({ invoiceNumber: inv.invoiceNumber, providerOptions: { receiptId } });
await provider.void({ invoiceNumber: inv.invoiceNumber, reason: "wrong", providerOptions: { receiptId } });
```

`providerOptions` fields: `receiptId`, `allowanceId`, `draft`, `emails` (notice
recipients), `zeroTaxRateReasonCode` / `customsClearanceType` (zero-rate),
`shouldAdjustTaxAmount` (B2B ±1 rounding), `items` (raw allowance lines
`[{id,quantity,price}]`).

## Cross-checked (read-only, with our own account — no invoice was issued)

- ✅ Auth and e-invoice **share one JWT**: a token from `api.simpany.co` reaches the
  application layer on `member2.simpany.co` (not blocked at 401).
- ✅ The base URL and `/c/{companyId}/receipts…` route structure are correct (routes matched).
- ✅ The error envelope is framework-style `{ message }` (with `{ errors }` when relevant);
  a company not enrolled for e-invoice gets a **404** on these routes (normalized to `NOT_FOUND`).

## Verification checklist — needs an e-invoice-enabled account (open an issue on mismatch)

1. Issue payload field names / required fields (esp. `customer`, `carrier`, `zeroTaxRateReasonCode`).
2. Issue/allowance RESPONSE field names (`invoiceNumber`, `randomNumber`, `issuedAt`, `allowanceNumber`, `id`).
3. The list query param used to resolve a receiptId from an invoice number (assumed `keyword=`).
4. Success envelope (assumed `{data}`) and the issue business-error shape (assumed `{status:"error",error:{title}}`).
5. Allowance confirmation flow (created as DRAFT — does it need a separate confirm step?).

## Tests

```bash
pnpm --filter @paid-tw/einvoice-simpany exec vitest run

# Live (auth layer only, against production):
SIMPANY_LIVE=1 SIMPANY_ACCOUNT=… SIMPANY_PASSWORD=… \
  pnpm exec vitest run packages/einvoice-simpany/src/__tests__/live
```

## Disclaimer

This adapter is provided as-is. Before using it, make sure your usage complies
with all applicable laws, tax/e-invoice regulations, and Simpany's terms of
service. You are responsible for confirming that programmatic access is
permitted for your account and use case.
