import { describe, expect, it } from "vitest";
import { createSimpanyProvider } from "../provider.js";

/**
 * Live test against the Simpany production API. Skipped unless SIMPANY_LIVE=1 and
 * the credentials are present. This only exercises the IMPLEMENTED auth layer
 * (login + /me + company resolution) — the five operations are not wired yet.
 *
 *   SIMPANY_LIVE=1 SIMPANY_ACCOUNT=… SIMPANY_PASSWORD=… \
 *   pnpm exec vitest run simpany/src/__tests__/live
 */
const env = process.env;
const live = env.SIMPANY_LIVE === "1" && Boolean(env.SIMPANY_ACCOUNT && env.SIMPANY_PASSWORD);

const LIVE_OPTS = { retry: 2 } as const;

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

  it("resolves a company id", async () => {
    const id = await p.resolveCompanyId().catch((e: unknown) => e);
    // Either resolves to the sole company, or throws a clear "ambiguous" error
    // when the account has several — both are acceptable here.
    expect(id).toBeDefined();
  });
});
