import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SimpanyClient, mapSimpanyError } from "../index.js";
import {
  fail,
  ok,
  okLogin,
  okMe,
  rframeworkError,
  rok,
  rpdf,
  rurl,
  server,
  url,
} from "./server.js";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const client = (overrides = {}) =>
  new SimpanyClient({ account: "user@example.com", password: "pw", ...overrides });

describe("token auth", () => {
  it("logs in lazily, caches the token, and sends it as a bearer", async () => {
    let logins = 0;
    const seen: (string | null)[] = [];
    server.use(
      http.post(url("/login"), () => {
        logins++;
        return okLogin("TOK1");
      }),
      http.get(url("/me"), ({ request }) => {
        seen.push(request.headers.get("authorization"));
        return okMe();
      }),
    );
    const c = client();
    await c.me();
    await c.me();
    expect(logins).toBe(1); // cached
    expect(seen).toEqual(["Bearer TOK1", "Bearer TOK1"]);
  });

  it("sends the login body and no auth header on the login call itself", async () => {
    let body: unknown;
    let auth: string | null = "unset";
    server.use(
      http.post(url("/login"), async ({ request }) => {
        body = await request.json();
        auth = request.headers.get("authorization");
        return okLogin();
      }),
      http.get(url("/me"), () => okMe()),
    );
    await client().me();
    expect(body).toEqual({ account: "user@example.com", password: "pw" });
    expect(auth).toBeNull();
  });

  it("uses a pre-supplied token without logging in", async () => {
    let logins = 0;
    let auth: string | null = null;
    server.use(
      http.post(url("/login"), () => {
        logins++;
        return okLogin();
      }),
      http.get(url("/me"), ({ request }) => {
        auth = request.headers.get("authorization");
        return okMe();
      }),
    );
    await client({ token: "PRESET", account: undefined, password: undefined }).me();
    expect(logins).toBe(0);
    expect(auth).toBe("Bearer PRESET");
  });

  it("throws AUTH when neither credentials nor a token are configured", async () => {
    await expect(client({ account: undefined, password: undefined }).me()).rejects.toMatchObject({
      code: "AUTH",
    });
  });

  it("throws AUTH when login returns no token", async () => {
    server.use(http.post(url("/login"), () => ok({ id: 1 })));
    await expect(client().login()).rejects.toMatchObject({ code: "AUTH" });
  });

  it("re-logs in once and retries on a 401", async () => {
    let logins = 0;
    let calls = 0;
    server.use(
      http.post(url("/login"), () => {
        logins++;
        return okLogin(`TOK${logins}`);
      }),
      http.get(url("/me"), () => {
        calls++;
        return calls === 1 ? fail(401, "expired") : okMe();
      }),
    );
    await client().me();
    expect(logins).toBe(2); // initial + one re-login
    expect(calls).toBe(2);
  });

  it("does not retry a 401 when it cannot re-login (token-only, no password)", async () => {
    let calls = 0;
    server.use(
      http.get(url("/me"), () => {
        calls++;
        return fail(401, "expired");
      }),
    );
    await expect(
      client({ token: "PRESET", account: undefined, password: undefined }).me(),
    ).rejects.toMatchObject({ code: "AUTH" });
    expect(calls).toBe(1); // no retry
  });

  it("maps a login failure (401) to AUTH", async () => {
    server.use(http.post(url("/login"), () => fail(401, "帳號或密碼錯誤")));
    await expect(client().login()).rejects.toMatchObject({ code: "AUTH", rawCode: "401" });
  });

  it("throws NETWORK when the transport fails", async () => {
    server.use(http.post(url("/login"), () => HttpResponse.error()));
    await expect(client().me()).rejects.toMatchObject({ code: "NETWORK" });
  });

  it("throws PROVIDER on a non-JSON success response", async () => {
    server.use(
      http.post(url("/login"), () => okLogin()),
      http.get(
        url("/me"),
        () => new HttpResponse("<html>", { headers: { "content-type": "text/html" } }),
      ),
    );
    await expect(client().me()).rejects.toMatchObject({ code: "PROVIDER" });
  });

  it("treats a 2xx body flagged status:error as a VALIDATION error", async () => {
    server.use(
      http.post(url("/login"), () => okLogin()),
      http.get(url("/me"), () =>
        HttpResponse.json({ status: "error", code: 4001, message: "nope" }),
      ),
    );
    await expect(client().me()).rejects.toMatchObject({ code: "VALIDATION", rawCode: "4001" });
  });

  it("honours a baseUrl override", async () => {
    let hit = false;
    server.use(
      http.post("https://proxy.example/v1/login", () => okLogin()),
      http.get("https://proxy.example/v1/me", () => {
        hit = true;
        return okMe();
      }),
    );
    await client({ baseUrl: "https://proxy.example/v1" }).me();
    expect(hit).toBe(true);
  });

  it("me() returns the account with its companies", async () => {
    server.use(
      http.post(url("/login"), () => okLogin()),
      http.get(url("/me"), () => okMe([{ id: 42, name: "ACME", permissions: ["e_receipt"] }])),
    );
    const me = await client().me();
    expect(me.companies).toHaveLength(1);
    expect(me.companies[0]).toMatchObject({ id: 42, name: "ACME" });
  });
});

describe("receipt host (member2)", () => {
  it("routes receipt() calls to the receipt base with the same bearer", async () => {
    let auth: string | null = null;
    server.use(
      http.post(url("/login"), () => okLogin("TOKR")),
      http.get(rurl("/c/3432/receipts"), ({ request }) => {
        auth = request.headers.get("authorization");
        return rok([{ id: 1, invoiceNumber: "AB11111111" }]);
      }),
    );
    const data = await client().receipt<Array<{ id: number }>>("GET", "/c/3432/receipts");
    expect(auth).toBe("Bearer TOKR");
    expect(data[0]?.id).toBe(1);
  });

  it("maps a receipt business error (status:error) to VALIDATION", async () => {
    server.use(
      http.post(url("/login"), () => okLogin()),
      http.post(rurl("/c/3432/receipts/b2c"), () =>
        HttpResponse.json({ status: "error", error: { title: "發票內容有誤" } }),
      ),
    );
    await expect(
      client().receipt("POST", "/c/3432/receipts/b2c", { customId: "x" }),
    ).rejects.toMatchObject({ code: "VALIDATION", rawMessage: "發票內容有誤" });
  });

  it("maps a framework-style { message } 404 to NOT_FOUND, preserving the message", async () => {
    // The real shape observed (read-only) from the receipt host when the company
    // isn't enrolled for e-invoice: a 404 with a framework-style `{ message }` body.
    server.use(
      http.post(url("/login"), () => okLogin()),
      http.get(rurl("/c/3432/receipts"), () => rframeworkError("No query results for model 3432")),
    );
    await expect(client().receipt("GET", "/c/3432/receipts")).rejects.toMatchObject({
      code: "NOT_FOUND",
      rawCode: "404",
      rawMessage: "No query results for model 3432",
    });
  });

  it("maps a framework-style 422 { message, errors } to VALIDATION", async () => {
    server.use(
      http.post(url("/login"), () => okLogin()),
      http.post(rurl("/c/3432/receipts/b2c"), () =>
        rframeworkError("The given data was invalid.", 422, { "customer.vat": ["invalid"] }),
      ),
    );
    await expect(
      client().receipt("POST", "/c/3432/receipts/b2c", { customId: "x" }),
    ).rejects.toMatchObject({ code: "VALIDATION", rawCode: "422" });
  });

  it("receiptFile returns bytes on a binary response", async () => {
    server.use(
      http.post(url("/login"), () => okLogin()),
      http.post(rurl("/c/3432/receipts/900/print"), () => rpdf([0x25, 0x50, 0x44, 0x46])),
    );
    const res = await client().receiptFile("POST", "/c/3432/receipts/900/print", {});
    expect(res.contentType).toContain("application/pdf");
    expect(Array.from(res.data)).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it("receiptFile throws the JSON error envelope on failure", async () => {
    server.use(
      http.post(url("/login"), () => okLogin()),
      http.post(rurl("/c/3432/receipts/900/print"), () => rframeworkError("not found", 404)),
    );
    await expect(
      client().receiptFile("POST", "/c/3432/receipts/900/print", {}),
    ).rejects.toMatchObject({ code: "NOT_FOUND", rawCode: "404" });
  });

  it("receiptFile re-logs in once on a 401 then returns bytes", async () => {
    let logins = 0;
    let calls = 0;
    server.use(
      http.post(url("/login"), () => {
        logins++;
        return okLogin(`TOK${logins}`);
      }),
      http.post(rurl("/c/3432/receipts/900/print"), () =>
        ++calls === 1 ? fail(401, "expired") : rpdf(),
      ),
    );
    const res = await client().receiptFile("POST", "/c/3432/receipts/900/print", {});
    expect(res.contentType).toContain("application/pdf");
    expect(logins).toBe(2);
  });

  it("honours a receiptBaseUrl override", async () => {
    let hit = false;
    server.use(
      http.post(url("/login"), () => okLogin()),
      http.get("https://rproxy.example/c/3432/receipts", () => {
        hit = true;
        return rok([]);
      }),
    );
    await client({ receiptBaseUrl: "https://rproxy.example" }).receipt("GET", "/c/3432/receipts");
    expect(hit).toBe(true);
  });
});

describe("mapSimpanyError (table-driven)", () => {
  it.each([
    [401, "AUTH"],
    [403, "AUTH"],
    [404, "NOT_FOUND"],
    [409, "CONFLICT"],
    [400, "VALIDATION"],
    [422, "VALIDATION"],
    [429, "PROVIDER"],
    [500, "PROVIDER"],
    [503, "PROVIDER"],
    [418, "UNKNOWN"],
  ])("status %i → %s", (status, expected) => {
    expect(mapSimpanyError(status)).toBe(expected);
  });
});
