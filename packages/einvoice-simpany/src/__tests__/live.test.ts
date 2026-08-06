import { isInvoiceError } from "@paid-tw/einvoice";
import { describe, expect, it } from "vitest";
import { createSimpanyProvider } from "../provider.js";

/**
 * Live test against the Simpany production API. Skipped unless SIMPANY_LIVE=1 and
 * the credentials are present. All five operations are implemented, but this
 * suite only exercises the read-only auth layer (login + /me + company
 * resolution) — the write paths would issue real invoices.
 *
 *   SIMPANY_LIVE=1 SIMPANY_ACCOUNT=… SIMPANY_PASSWORD=… \
 *   pnpm exec vitest run simpany/src/__tests__/live
 *
 * ⚠️ Every test below MUST share the single `p` created in the describe block.
 * `POST /v1/login` is throttled at ~6 requests/minute, and each new provider
 * logs in again — building one per test trips the throttle and turns the whole
 * file red with rate-limit errors that look nothing like the assertions being
 * made. `retry` is deliberately not set here for the same reason: retrying a
 * throttled call just burns the next minute's budget.
 */
const env = process.env;
const live = env.SIMPANY_LIVE === "1" && Boolean(env.SIMPANY_ACCOUNT && env.SIMPANY_PASSWORD);

const LIVE_OPTS = { timeout: 30_000 } as const;

const provider = () =>
  createSimpanyProvider({
    account: env.SIMPANY_ACCOUNT!,
    password: env.SIMPANY_PASSWORD!,
  });

describe.skipIf(!live)("Simpany live (production) — auth layer", LIVE_OPTS, () => {
  const p = provider();

  it("logs in and returns the account with at least one company", async () => {
    const me = await p.me();
    expect(me.email).toBeTruthy();
    expect(Array.isArray(me.companies)).toBe(true);
    expect(me.companies.length).toBeGreaterThan(0);
    // Surface what the account can do — this is how we learn whether e-invoice is
    // enabled (a `permissions` entry) so the operations can be wired.
    console.log(
      "companies:",
      me.companies.map((c) => ({ id: c.id, name: c.name, permissions: c.permissions })),
    );
  });

  it("resolves a company id, or reports the documented ambiguity", async () => {
    try {
      // A sole company must resolve to its id.
      const id = await p.resolveCompanyId();
      expect(["string", "number"]).toContain(typeof id);
    } catch (e) {
      // Several companies without config.companyId/companyUbn must surface as
      // the specific VALIDATION "ambiguous company" error — anything else
      // (auth, network) is a real regression and fails here.
      expect(isInvoiceError(e)).toBe(true);
      expect(e).toMatchObject({
        code: "VALIDATION",
        message: expect.stringContaining("companies"),
      });
    }
  });
});
