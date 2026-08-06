import { isInvoiceError, InvoiceErrorCode } from "@paid-tw/einvoice";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isThrottled, retryAfterSeconds } from "../client.js";
import { okLogin, okMe, server, testProvider, url } from "./server.js";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/**
 * `POST /v1/login` is throttled at ~6/min and answers 429 with an HTML page, not
 * the usual JSON envelope. These tests pin the behaviour that keeps that legible:
 * without the pre-parse check the HTML would fail `JSON.parse` first and the
 * throttle would be reported as "Simpany returned a non-JSON response".
 */
const THROTTLE_HTML =
  "<!DOCTYPE html><html><head><title>Too Many Requests</title></head><body>429</body></html>";

const throttled = () =>
  new HttpResponse(THROTTLE_HTML, {
    status: 429,
    headers: {
      "content-type": "text/html; charset=UTF-8",
      "retry-after": "21",
      "x-ratelimit-limit": "6",
      "x-ratelimit-remaining": "0",
    },
  });

describe("helpers", () => {
  it("recognises 429 and nothing else", () => {
    expect(isThrottled(429)).toBe(true);
    expect(isThrottled(401)).toBe(false);
    expect(isThrottled(503)).toBe(false);
  });

  it("reads a numeric Retry-After, ignoring the HTTP-date form", () => {
    expect(retryAfterSeconds(new Headers({ "retry-after": "21" }))).toBe(21);
    expect(retryAfterSeconds(new Headers())).toBeUndefined();
    expect(
      retryAfterSeconds(new Headers({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" })),
    ).toBeUndefined();
  });
});

describe("a throttled login", () => {
  it("does not surface as a non-JSON parse failure", async () => {
    server.use(http.post(url("/login"), () => throttled()));
    const err = await testProvider()
      .me()
      .catch((e: unknown) => e);

    expect(isInvoiceError(err)).toBe(true);
    expect((err as { message: string }).message).not.toContain("non-JSON");
  });

  it("names the throttle, the cap and the wait, and points at the cause", async () => {
    server.use(http.post(url("/login"), () => throttled()));
    const err = (await testProvider()
      .me()
      .catch((e: unknown) => e)) as {
      message: string;
      code: string;
      rawCode: string;
      raw: unknown;
    };

    expect(err.message).toContain("rate limit");
    expect(err.message).toContain("limit 6/min");
    expect(err.message).toContain("Retry after 21s");
    // The actionable part: a new client means a new login, and login is throttled.
    expect(err.message).toContain("Reuse one SimpanyClient");
    expect(err.code).toBe(InvoiceErrorCode.PROVIDER);
    expect(err.rawCode).toBe("429");
    expect(err.raw).toMatchObject({ status: 429, retryAfterSeconds: 21, limit: "6" });
  });

  it("still reports a genuinely malformed 200 body as non-JSON", async () => {
    server.use(http.post(url("/login"), () => new HttpResponse("<html>not json</html>")));
    const err = await testProvider()
      .me()
      .catch((e: unknown) => e);
    expect((err as { message: string }).message).toContain("non-JSON");
  });
});

describe("a throttled authenticated call", () => {
  it("is reported as a throttle, not as an auth failure", async () => {
    server.use(
      http.post(url("/login"), () => okLogin()),
      http.get(url("/me"), () => throttled()),
    );
    const err = (await testProvider()
      .me()
      .catch((e: unknown) => e)) as { message: string; code: string };
    expect(err.message).toContain("rate limit");
    expect(err.code).not.toBe(InvoiceErrorCode.AUTH);
  });

  it("does not trigger the 401 re-login path, which would spend more budget", async () => {
    let logins = 0;
    server.use(
      http.post(url("/login"), () => {
        logins += 1;
        return okLogin();
      }),
      http.get(url("/me"), () => throttled()),
    );
    await testProvider()
      .me()
      .catch(() => undefined);
    expect(logins).toBe(1);
  });
});

describe("one client, one login", () => {
  it("reuses the cached token across calls so the throttle is not approached", async () => {
    let logins = 0;
    server.use(
      http.post(url("/login"), () => {
        logins += 1;
        return okLogin();
      }),
      http.get(url("/me"), () => okMe()),
    );
    const provider = testProvider();
    await provider.me();
    await provider.me();
    await provider.me();
    expect(logins).toBe(1);
  });
});
