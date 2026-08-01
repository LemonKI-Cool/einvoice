---
"@paid-tw/einvoice-ecpay": patch
---

Fix ECPay error mapping for three live-verified codes and add a named `productServiceId` option (issue #3).

- `5070450` (該發票已被折讓過，無法直接作廢) now maps to `reason: void_blocked_by_allowance` instead of the wrong `already_voided`. The real `RtnMsg` contains both 折讓 and 作廢, and the old keyword match read the trailing 作廢 — a data-integrity bug that could mark a still-valid, allowance-bearing invoice as voided and skip the refund allowance.
- `5070357` (自訂編號重覆 — note 覆, not 複) now maps to `CONFLICT` / `duplicate_order` instead of a terminal `VALIDATION`, so an ambiguous-timeout resend can be reclaimed by `RelateNumber` (aligns with Amego/ezPay).
- `5070453` (該發票已被作廢過) now maps to `CONFLICT` / `already_voided` instead of `VALIDATION`.

These stable codes are pinned in a `RtnCode` table (code-first, keyword fallback), and the keyword fallback is hardened: void-blocked is matched before already-voided, and 覆/複 variants are handled. Also adds `providerOptions.productServiceId` (ECPay `ProductServiceID`) — required by the public sandbox, otherwise every issue returns `5070350`.
