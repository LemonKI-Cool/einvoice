import { InvoiceError, InvoiceErrorCode, tracedFetch } from "@paid-tw/einvoice";
import { type SimpanyConfig, resolveBaseUrl, resolveReceiptBaseUrl } from "./config.js";
import { AUTH_ENDPOINTS } from "./endpoints.js";

/**
 * Simpany's response envelope. The auth host uses `{ status:"ok", code, data }`;
 * the receipt host returns `{ data }` on success and `{ status:"error", error }`
 * (or a 4xx `{ errors }`) on failure. Parsing tolerates both.
 */
export interface SimpanyEnvelope<T = unknown> {
  status?: string;
  code?: number;
  message?: string;
  data?: T;
  error?: { title?: string; message?: string; [key: string]: unknown };
  errors?: Record<string, unknown>;
}

/** Shape of `data` from `POST /v1/login`. */
export interface SimpanyLoginData {
  id: number;
  token: string;
}

/** A company under the logged-in account (from `GET /v1/me`). */
export interface SimpanyCompany {
  id: number;
  name: string;
  /** 統一編號, when the API exposes it. */
  ubn?: string;
  structure?: string;
  service_type?: string;
  operating_status?: string;
  /** Feature flags — e-invoice is gated by `"e_receipt"`. */
  permissions?: string[];
  [key: string]: unknown;
}

/** Shape of `data` from `GET /v1/me`. */
export interface SimpanyMe {
  id: number;
  name: string;
  email: string;
  serverTime?: string;
  companies: SimpanyCompany[];
  [key: string]: unknown;
}

/** Which host a call targets — both use the same bearer token. */
export type SimpanyHost = "auth" | "receipt";

/**
 * Map an HTTP status (and optional envelope code) to a unified
 * {@link InvoiceErrorCode}. Simpany largely follows HTTP semantics.
 *
 * 429 lands on PROVIDER because the unified enum has no rate-limit member; the
 * throttle is instead made legible through the error message and the
 * `Retry-After` seconds carried on `raw` — see {@link isThrottled}.
 */
export function mapSimpanyError(httpStatus: number, code?: number): InvoiceErrorCode {
  const s = httpStatus || code || 0;
  if (s === 401 || s === 403) return InvoiceErrorCode.AUTH;
  if (s === 404) return InvoiceErrorCode.NOT_FOUND;
  if (s === 409) return InvoiceErrorCode.CONFLICT;
  if (s === 422 || s === 400) return InvoiceErrorCode.VALIDATION;
  if (s === 429) return InvoiceErrorCode.PROVIDER;
  if (s >= 500) return InvoiceErrorCode.PROVIDER;
  return InvoiceErrorCode.UNKNOWN;
}

/**
 * `POST /v1/login` is throttled — observed at **6 requests per minute**
 * (`X-RateLimit-Limit: 6`), and the 429 reply is an HTML error page, not the
 * usual JSON envelope.
 *
 * That combination is a trap worth naming: without this check the HTML body
 * fails `JSON.parse` first, and the throttle surfaces as "Simpany returned a
 * non-JSON response" — which reads like a broken endpoint rather than
 * back-pressure. It is easy to hit by accident, because every new
 * `SimpanyClient` logs in again: a handful of short-lived clients (a test file
 * that builds one per case, a request handler that constructs one per request)
 * is enough. Share one client — the JWT is good for 30 days.
 */
export function isThrottled(status: number): boolean {
  return status === 429;
}

/**
 * `Retry-After` in whole seconds, when the server sent a valid delta-seconds
 * value (a non-negative integer, per RFC 9110). The HTTP-date form and any
 * malformed value yield `undefined`.
 */
export function retryAfterSeconds(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

/** Build the throttle error, naming the wait so callers can back off. */
function throttleError(res: Response, path: string): InvoiceError {
  const retryAfter = retryAfterSeconds(res.headers);
  const limit = res.headers.get("x-ratelimit-limit");
  const wait = retryAfter === undefined ? "" : ` Retry after ${retryAfter}s.`;
  const cap = limit ? ` (limit ${limit}/min)` : "";
  // The client-reuse advice only makes sense when login itself was throttled.
  const advice =
    path === AUTH_ENDPOINTS.login
      ? " Reuse one SimpanyClient — each new client logs in again, and login is the throttled endpoint."
      : " Back off before retrying.";
  return new InvoiceError(`Simpany rate limit hit on ${path}${cap}.${wait}${advice}`, {
    provider: "simpany",
    code: mapSimpanyError(res.status),
    rawCode: String(res.status),
    rawMessage: `HTTP 429${cap}`,
    raw: { status: 429, retryAfterSeconds: retryAfter, limit },
  });
}

/**
 * Stateful Simpany client. Holds the JWT, logs in lazily, and transparently
 * re-logs in once on a 401 — across BOTH hosts (auth + receipt), which share the
 * token. Throws an {@link InvoiceError} on any failure; returns the envelope's
 * `data` on success.
 */
export class SimpanyClient {
  private token?: string;

  constructor(private readonly config: SimpanyConfig) {
    this.token = config.token;
  }

  /** The (possibly cached) access token, logging in if necessary. */
  async ensureToken(): Promise<string> {
    if (this.token) return this.token;
    return this.login();
  }

  /** Force a fresh login and cache the new token. */
  async login(): Promise<string> {
    if (!this.config.account || !this.config.password) {
      throw new InvoiceError(
        "Simpany login requires account + password (or a pre-obtained token)",
        { provider: "simpany", code: InvoiceErrorCode.AUTH, rawMessage: "missing credentials" },
      );
    }
    const data = await this.transport<SimpanyLoginData>("auth", "POST", AUTH_ENDPOINTS.login, {
      account: this.config.account,
      password: this.config.password,
    });
    if (!data?.token) {
      throw new InvoiceError("Simpany login returned no token", {
        provider: "simpany",
        code: InvoiceErrorCode.AUTH,
        rawMessage: "no token in response",
        raw: data,
      });
    }
    this.token = data.token;
    return this.token;
  }

  /** `GET /v1/me` — the account and its companies (each with `permissions`). */
  async me(): Promise<SimpanyMe> {
    return this.request<SimpanyMe>("GET", AUTH_ENDPOINTS.me);
  }

  /** Authenticated call to the AUTH host (`api.simpany.co`). */
  request<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    return this.call<T>("auth", method, path, body);
  }

  /** Authenticated call to the RECEIPT host (`member2.simpany.co`). */
  receipt<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    return this.call<T>("receipt", method, path, body);
  }

  /** Ensure a token, send with a bearer, and re-login once on a 401. */
  private async call<T>(
    host: SimpanyHost,
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    await this.ensureToken();
    try {
      return await this.transport<T>(host, method, path, body, this.token);
    } catch (err) {
      // Re-login once on an auth failure (expired/rotated token), then retry.
      if (
        err instanceof InvoiceError &&
        err.code === InvoiceErrorCode.AUTH &&
        this.config.password
      ) {
        await this.login();
        return this.transport<T>(host, method, path, body, this.token);
      }
      throw err;
    }
  }

  /**
   * One request: fetch, parse the envelope, throw on failure. `bearer` is omitted
   * for the login call. NETWORK on transport failure, PROVIDER on a non-JSON body.
   */
  private async transport<T>(
    host: SimpanyHost,
    method: string,
    path: string,
    body?: Record<string, unknown>,
    bearer?: string,
  ): Promise<T> {
    const doFetch = this.config.fetch ?? fetch;
    const base = host === "auth" ? resolveBaseUrl(this.config) : resolveReceiptBaseUrl(this.config);
    const headers: Record<string, string> = {
      accept: "application/json",
      "x-requested-with": "XMLHttpRequest",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (bearer) headers.authorization = `Bearer ${bearer}`;

    let res: Response;
    try {
      res = await tracedFetch(
        { provider: "simpany", debug: this.config.debug, fetch: doFetch },
        `${base}${path}`,
        {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: this.config.timeoutMs ? AbortSignal.timeout(this.config.timeoutMs) : undefined,
        },
      );
    } catch (cause) {
      throw new InvoiceError("Simpany request failed", {
        provider: "simpany",
        code: InvoiceErrorCode.NETWORK,
        cause,
      });
    }

    // Some endpoints (204 No Content, binary) carry no JSON body.
    const raw = await res.text();

    // Check the throttle BEFORE parsing: a 429 body is HTML, so parsing first
    // would report it as a non-JSON response and hide the real cause.
    if (isThrottled(res.status)) throw throttleError(res, path);

    let env: SimpanyEnvelope<T> = {};
    if (raw) {
      try {
        env = JSON.parse(raw) as SimpanyEnvelope<T>;
      } catch (cause) {
        throw new InvoiceError("Simpany returned a non-JSON response", {
          provider: "simpany",
          code: res.ok ? InvoiceErrorCode.PROVIDER : mapSimpanyError(res.status),
          rawCode: String(res.status),
          cause,
        });
      }
    }

    // Failure: a non-2xx status, or a 2xx body flagged `status:"error"`.
    const bodyError = env.status === "error";
    if (!res.ok || bodyError) {
      const message =
        env.error?.title || env.error?.message || env.message || `Simpany error ${res.status}`;
      throw new InvoiceError(message, {
        provider: "simpany",
        // A 2xx business error can't be classified by status — default to VALIDATION.
        code: res.ok ? InvoiceErrorCode.VALIDATION : mapSimpanyError(res.status, env.code),
        rawCode: String(env.code ?? res.status),
        rawMessage: message,
        raw: env,
      });
    }

    // Success: prefer the `data` envelope field; fall back to the whole body.
    return (env.data !== undefined ? env.data : (env as unknown as T)) as T;
  }

  /**
   * Authenticated BINARY call to the receipt host — for endpoints that stream a
   * PDF (invoice/allowance proof) instead of JSON. Returns the bytes + content
   * type on success; on failure the API replies with a JSON envelope, which is
   * thrown as an {@link InvoiceError}. Re-logs in once on a 401 like the others.
   */
  async receiptFile(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ contentType: string; data: Uint8Array }> {
    await this.ensureToken();
    try {
      return await this.transportFile(method, path, body, this.token);
    } catch (err) {
      if (
        err instanceof InvoiceError &&
        err.code === InvoiceErrorCode.AUTH &&
        this.config.password
      ) {
        await this.login();
        return this.transportFile(method, path, body, this.token);
      }
      throw err;
    }
  }

  private async transportFile(
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
    bearer?: string,
  ): Promise<{ contentType: string; data: Uint8Array }> {
    const doFetch = this.config.fetch ?? fetch;
    const base = resolveReceiptBaseUrl(this.config);
    const headers: Record<string, string> = {
      accept: "application/pdf, application/json",
      "x-requested-with": "XMLHttpRequest",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (bearer) headers.authorization = `Bearer ${bearer}`;

    let res: Response;
    try {
      res = await tracedFetch(
        { provider: "simpany", debug: this.config.debug, fetch: doFetch },
        `${base}${path}`,
        {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: this.config.timeoutMs ? AbortSignal.timeout(this.config.timeoutMs) : undefined,
        },
      );
    } catch (cause) {
      throw new InvoiceError("Simpany request failed", {
        provider: "simpany",
        code: InvoiceErrorCode.NETWORK,
        cause,
      });
    }

    // Same trap as `transport`: a throttled reply is an HTML page, so it has to
    // be recognised before anything tries to read it as an error envelope.
    if (isThrottled(res.status)) throw throttleError(res, path);

    const ct = res.headers.get("content-type") ?? "";
    // A JSON body (or a non-2xx) is an error envelope, not a file.
    if (!res.ok || ct.includes("application/json")) {
      const raw = await res.text();
      let env: SimpanyEnvelope = {};
      try {
        env = raw ? (JSON.parse(raw) as SimpanyEnvelope) : {};
      } catch {
        // non-JSON error body — fall through with an empty envelope
      }
      const message =
        env.error?.title || env.error?.message || env.message || `Simpany error ${res.status}`;
      throw new InvoiceError(message, {
        provider: "simpany",
        code: res.ok ? InvoiceErrorCode.VALIDATION : mapSimpanyError(res.status, env.code),
        rawCode: String(env.code ?? res.status),
        rawMessage: message,
        raw: env,
      });
    }
    return {
      contentType: ct || "application/octet-stream",
      data: new Uint8Array(await res.arrayBuffer()),
    };
  }
}
