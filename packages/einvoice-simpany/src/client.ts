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
}
