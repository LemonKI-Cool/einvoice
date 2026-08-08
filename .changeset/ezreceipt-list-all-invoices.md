---
"@paid-tw/einvoice-ezreceipt": patch
---

Add `EzreceiptProvider.listAllInvoices()` — fetches page 1 to learn the total `entries`, then follows pagination to concatenate every raw row. The ergonomic path for reconciliation/export, since the single-page `listInvoices` caps at `pageSize`.
