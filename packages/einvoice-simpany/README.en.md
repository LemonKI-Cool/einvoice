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

> Legend: ✅ = checked against the live API (VERIFIED); ⚠️ = hand-compiled, not yet
> tested (UNVERIFIED).

## Architecture & how it works

- This package implements core's `InvoiceProvider` contract (`@paid-tw/einvoice`).
  Application code depends only on that interface, so switching providers is just a
  different constructor (`createSimpanyProvider(...)`) — nothing else changes.
- Simpany publishes no developer API; the shape below was compiled by hand and may
  be inaccurate.
- **Two hosts, one JWT:**
  - Auth/account: `https://api.simpany.co/v1` (`POST /login`, `GET /me`) — ✅ verified
  - E-invoice (internally "receipt"): `https://member2.simpany.co/api/v1/c/{companyId}/…` — ⚠️ unverified
- **Request flow** (issue as the example):
  1. lazily log in for a JWT (or use an injected `token`)
  2. resolve `companyId` (from config, or `GET /me`)
  3. call the receipt host `POST /c/{companyId}/receipts/{b2b|b2c}` with `Authorization: Bearer <token>`

## Authentication

- **Credentials → token:** `POST https://api.simpany.co/v1/login` with body
  `{ account, password }` (`account` is the member's email) → `{ status:"ok", data:{ id, token } }`.
- **The token is a JWT bearer**, lifetime ~**30 days** (`exp − iat = 2,592,000`s). Every
  subsequent request carries the header `Authorization: Bearer <token>`.
- **One token authorizes both hosts** (cross-checked): the auth host and the receipt host share it.
- **Client behaviour:** lazy login (only on the first call) → token cached → on a `401`,
  re-login once and retry (requires a `password` in config).
- **Inject a token directly:** set `token` to skip the credential login (e.g. from a vault);
  `account` / `password` are then optional.
- Login has **no captcha / CSRF / MFA**; credentials go to `/login` over TLS only.
- ⚠️ **Security:** the token is a 30-day long-lived credential — keep it server-side, never in
  the frontend or version control; manage both credentials and token as env vars / secrets.
  Trace logs **never record request/response bodies** (see "Errors & debugging").

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

## Issue fields & required rules

`POST /c/{cid}/receipts/{b2b|b2c}`. Required/format below come from the issue
form's client-side validation (**server contract unverified**); the adapter runs
the same checks locally before sending (disable with `validatePayload: false`).

| wire field | required | rule / values | unified |
|---|---|---|---|
| `customId` | optional | any string | `orderId` |
| `customer.vat` | B2B only | 8 digits | `buyer.ubn` |
| `customer.name` | B2B only | ≤255 | `buyer.name` |
| `customer.address` | optional | — | `buyer.address` |
| `customer.emails` | **required** | email (multiple allowed) | `buyer.email` |
| `taxType` | required | `TAXABLE` / `ZERO_TAX_RATE` / `EXEMPTION` | `taxType` |
| `isTaxIncluded` | required | boolean | `priceMode` |
| `items[].name` | required | ≤255 | `item.description` |
| `items[].quantity` | required | 1–999999 | `item.quantity` |
| `items[].price` | required | 0–99999999 | `item.unitPrice` |
| `items[].subTotal` | required | = quantity × price | `item.amount` |
| `carrier.type` | B2C | `NO_CARRIER`/`MOBILE_BARCODE`/`CITIZEN_DIGITAL_CERTIFICATE`/`MEMBERSHIP` | `carrier.type` |
| `carrier.number` | per type | mobile `/`+7 chars; citizen-cert 16 chars (2 letters + 14 digits) | `carrier.code` |
| `npoBan` | B2C + donate | 3–7 digits | `donation.npoban` |
| `zeroTaxRateReasonCode` | zero-rate | code (see `zero-tax-rate-reasons`) | `providerOptions` |
| `customsClearanceType` | zero-rate | `NOT_VIA_CUSTOMS` / `VIA_CUSTOMS` | `providerOptions` |
| `remark` | optional | — | `remark` |
| `shouldAdjustTaxAmount` | optional | boolean (B2B ±1) | `providerOptions` |

> Note: the form offers no issue-date field (the server issues at "now"), so the
> unified `date` has no effect on Simpany.

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

## Configuration (SimpanyConfig)

| field | required | notes |
|---|---|---|
| `account` | one of | login account (member email). One of `account`+`password` or `token` |
| `password` | one of | login password (TLS only). Needed for auto re-login on a 401 |
| `token` | one of | a pre-obtained JWT, to skip the credential login |
| `companyId` | optional | scope requests to this company; else resolved via `GET /me` |
| `companyUbn` | optional | pick a company by 統編 when several exist |
| `validatePayload` | optional | default `true`; local pre-flight validation (set `false` to skip) |
| `timeoutMs` | optional | per-request timeout (ms) |
| `baseUrl` | optional | override the auth host base (default `https://api.simpany.co/v1`) |
| `receiptBaseUrl` | optional | override the receipt host base (default `https://member2.simpany.co/api/v1`) |
| `debug` | optional | trace callback (metadata-only, see below) |
| `fetch` | optional | inject a custom `fetch` (testing / edge runtime) |

## Errors & debugging

- **Every failure throws core's `InvoiceError`** (never a raw error), carrying:
  - `code`: `AUTH` / `VALIDATION` / `NOT_FOUND` / `CONFLICT` / `NETWORK` / `PROVIDER` / `UNSUPPORTED` / `UNKNOWN`
  - `rawCode`, `rawMessage`, `raw` (the original response, for debugging)
  - Narrow with `isInvoiceError(e)`, **not `instanceof`** (which breaks across ESM/CJS or version skew).
- **Mapping:** HTTP `401`/`403`→`AUTH`, `404`→`NOT_FOUND`, `409`→`CONFLICT`, `400`/`422`→`VALIDATION`,
  `429` and `5xx`→`PROVIDER`; transport failure→`NETWORK`. Both member2 error shapes (framework
  `{message}` / `{errors}` and business `{status:"error",error:{title}}`) are normalized.
- **Tracing:** set `debug` to receive per-request metadata (`provider` / `method` / `url` / `status` /
  `durationMs` / `error`); request/response **bodies are never logged** (possible PII / encrypted
  content). To capture bodies, wrap your own `fetch` and pass it as `config.fetch`.

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
