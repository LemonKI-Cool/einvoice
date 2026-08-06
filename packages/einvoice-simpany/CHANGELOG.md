# @paid-tw/einvoice-simpany

## 0.1.1

### Patch Changes

- No functional changes. First release published through the repo's OIDC
  trusted-publishing pipeline (0.1.0 was published manually with an OTP before
  the trusted publisher was configured).

## 0.1.0

### Minor Changes

- First release of the Simpany (simpany.co) adapter. The auth layer and READ
  path are verified against a live e-invoice-enabled account; the WRITE
  payloads (issue / void / allowance / void-allowance) are hand-compiled and
  UNVERIFIED — see the README before use. Implements the five unified
  operations plus read-only extensions (listReceipts, listTrackNumbers,
  canIssue, notifyReceipt, printReceipt, getSubscriptionStatus,
  listFrequentItems).

## 0.0.0 (unreleased — private)

Initial adapter. Private (not published) until the e-invoice operations are
verified against a live e-invoice-enabled account.

- Verified against the live API: `SimpanyClient` (lazy login, JWT bearer shared
  across the auth + receipt hosts, token cache, one-shot re-login on 401),
  `me()`, `resolveCompanyId()`, `mapSimpanyError`.
- Implemented but **UNVERIFIED** (details compiled by hand, may be inaccurate):
  `issue` / `void` / `allowance` / `voidAllowance` / `query`, plus the endpoint
  map and enums. `capabilities` = ISSUE / VOID / ALLOWANCE / VOID_ALLOWANCE /
  QUERY / B2B.

See the README for the verification checklist and disclaimer. Using this adapter
is your responsibility — confirm it complies with applicable regulations and
Simpany's terms of service.
