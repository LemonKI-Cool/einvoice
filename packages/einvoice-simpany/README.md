# @paid-tw/einvoice-simpany

Simpany（[simpany.co](https://simpany.co/e-invoice)）的 [@paid-tw/einvoice](../einvoice) 供應商轉接器。

> ⚠️ **五個操作的細節由我們人工梳理整理,可能有誤,尚未對過真實 API。**
> 登入 / `me` / 公司解析這層已對過正式 API（VERIFIED）；但開立、作廢、折讓、折讓作廢、
> 查詢的端點、payload、欄位名稱是人工整理出來的,**還沒用「已開通電子發票的帳號」實際
> 驗證過**。請當成 best-effort 起點使用,遇到不符就發 GitHub issue。本套件標記
> `private: true`,驗證通過前不會發佈到 npm。
>
> 使用前**請務必詳閱下方[免責聲明](#免責聲明)**,並自行確認符合相關法規與 Simpany 服務條款。

## API 概觀

Simpany 沒有公開的開發者 API,以下是我們人工整理的形狀(可能有誤):

- **兩個 host、同一顆 JWT**:
  - 帳號 / 認證:`https://api.simpany.co/v1/`（`POST /login`、`GET /me`）— 已驗證。
  - 電子發票（內部稱 **receipt**）:`https://member2.simpany.co/api/v1/c/{companyId}/…` — 待驗證。
- 登入 `POST /v1/login { account, password }` → `{ data:{ id, token } }`,`token` 是效期
  約 30 天的 JWT,同一顆同時授權兩個 host。

## 操作與端點（人工整理,UNVERIFIED）

| 統一操作 | HTTP | 端點（receipt base 之下） |
|---|---|---|
| 開立 `issue` | POST | `/c/{cid}/receipts/{b2b\|b2c}` |
| 作廢 `void` | DELETE | `/c/{cid}/receipts/{receiptId}`,body `{reason, emails}` |
| 折讓 `allowance` | POST | `/c/{cid}/receipts/{receiptId}/draft-allowances`,body `{emails, items:[{id,quantity,price}]}` |
| 折讓作廢 `voidAllowance` | DELETE | `/c/{cid}/allowances/{id}`(或 `/draft-allowances/{id}`) |
| 查詢 `query` | GET | `/c/{cid}/receipts/{receiptId}` |

- **內部 id vs 發票號碼**:作廢 / 查詢 / 折讓是用 Simpany 的**內部 receipt id**,不是發票號碼。
  請把 `issue` 結果的 `raw.id` 透過 `providerOptions.receiptId` 傳回來(最可靠);只給發票號碼
  時會嘗試用列表的 `keyword` 查詢反查——但那個查詢參數尚未驗證。
- **折讓作廢**必須帶 `providerOptions.allowanceId`(內部 id);若折讓還在「待確認(DRAFT)」
  狀態,加 `providerOptions.draft: true` 走 draft 端點。
- **能力**:宣告 ISSUE / VOID / ALLOWANCE / VOID_ALLOWANCE / QUERY / B2B。**不支援**
  MIXED_TAX(稅別為發票層級)、FOREIGN_CURRENCY、CARRIER_VALIDATION(前端無此端點)。

## 用法

```ts
import { createSimpanyProvider } from "@paid-tw/einvoice-simpany";

const provider = createSimpanyProvider({
  account: process.env.SIMPANY_ACCOUNT!,
  password: process.env.SIMPANY_PASSWORD!,
  // companyId: 3432,        // 指定公司；省略則由 /me 解析(唯一公司或以 companyUbn 挑選)
});

// 開立(B2C,依 buyer.ubn 自動判斷 B2B/B2C)
const inv = await provider.issue({
  orderId: "ORD-1",
  buyer: { name: "買受人", email: "buyer@example.com" },
  items: [{ description: "商品A", quantity: 2, unitPrice: 50, amount: 100 }],
  amount: { salesAmount: 100, taxAmount: 5, totalAmount: 105 },
  taxType: "TAXABLE",
  priceMode: "TAX_EXCLUSIVE",
});

// 後續操作把 raw.id 傳回來當 receiptId
const receiptId = (inv.raw as { id: number }).id;
await provider.query({ invoiceNumber: inv.invoiceNumber, providerOptions: { receiptId } });
await provider.void({ invoiceNumber: inv.invoiceNumber, reason: "開錯", providerOptions: { receiptId } });
```

`providerOptions` 可帶的欄位:`receiptId`、`allowanceId`、`draft`、`emails`(通知信收件人)、
`zeroTaxRateReasonCode` / `customsClearanceType`(零稅率用)、`shouldAdjustTaxAmount`(B2B ±1 稅額調整)、
`items`(直接指定折讓品項 `[{id,quantity,price}]`)。

## 待驗證清單(接手的人請優先確認,對不上就發 issue)

1. 開立 payload 的欄位名與必填(尤其 `customer`、`carrier`、`zeroTaxRateReasonCode`)。
2. 開立/折讓**回應**的欄位名(`invoiceNumber`、`randomNumber`、`issuedAt`、`allowanceNumber`、`id`)。
3. 以發票號碼反查 receiptId 的列表查詢參數(目前假設 `keyword=`)。
4. member2 的成功 / 錯誤 envelope(目前:成功 `{data}`、錯誤 `{status:"error",error:{title}}` 或 422 `{errors}`)。
5. 折讓確認流程(建立後為 DRAFT,是否需要額外「確認」步驟才生效)。

## 測試

```bash
pnpm --filter @paid-tw/einvoice-simpany exec vitest run

# Live(僅驗證登入層,打正式環境):
SIMPANY_LIVE=1 SIMPANY_ACCOUNT=… SIMPANY_PASSWORD=… \
  pnpm exec vitest run packages/einvoice-simpany/src/__tests__/live
```

## 免責聲明

本套件依現狀（as-is）提供。使用前請務必自行確認你的使用方式符合相關法規、電子發票 /
稅務規範,以及 Simpany 的服務條款;並確認你的帳號與使用情境允許以程式方式存取。相關責任
由使用者自行承擔。
