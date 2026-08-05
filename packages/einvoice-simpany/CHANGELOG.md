# @paid-tw/einvoice-simpany

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
