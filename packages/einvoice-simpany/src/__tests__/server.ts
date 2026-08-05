import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createSimpanyProvider, type SimpanyConfig } from "../index.js";

export const BASE = "https://api.simpany.co/v1";
export const RECEIPT_BASE = "https://member2.simpany.co/api/v1";
/** Auth-host URL. */
export const url = (path: string) => `${BASE}${path}`;
/** Receipt-host URL. */
export const rurl = (path: string) => `${RECEIPT_BASE}${path}`;

export const server = setupServer();

export function testProvider(overrides: Partial<SimpanyConfig> = {}) {
  return createSimpanyProvider({
    account: "user@example.com",
    password: "pw",
    ...overrides,
  });
}

// --- auth-host (api.simpany.co) envelopes: { status:"ok", code, data } --------

/** A generic auth success envelope. */
export const ok = (data: unknown) => HttpResponse.json({ status: "ok", code: 200, data });

/** A login success envelope (carries `data.token`). */
export const okLogin = (token = "jwt_test", id = 5129) =>
  HttpResponse.json({ status: "ok", code: 200, data: { id, token } });

/** A `/me` success envelope. `companies` defaults to a single company (id 3432). */
export const okMe = (
  companies: Array<Record<string, unknown>> = [{ id: 3432, name: "Test Co", permissions: [] }],
) =>
  HttpResponse.json({
    status: "ok",
    code: 200,
    data: { id: 5129, name: "Test User", email: "user@example.com", companies },
  });

/** An error envelope at the given HTTP status (both hosts accept this shape). */
export const fail = (httpStatus: number, message = "err", code?: number) =>
  HttpResponse.json({ status: "error", code: code ?? httpStatus, message }, { status: httpStatus });

/** The default login handler — most flows need a token first. */
export const loginHandler = (token = "jwt_test") => http.post(url("/login"), () => okLogin(token));

// --- receipt-host (member2.simpany.co) envelopes: { data } / { status:"error" }

/** A receipt success envelope `{ data }`. */
export const rok = (data: unknown) => HttpResponse.json({ data });

/** A receipt business-error envelope (HTTP 200, `status:"error"`). */
export const rerror = (title = "發票內容有誤") =>
  HttpResponse.json({ status: "error", error: { title } });

/** A binary PDF response (for print/proof endpoints). Defaults to a `%PDF` stub. */
export const rpdf = (bytes: number[] = [0x25, 0x50, 0x44, 0x46]) =>
  new HttpResponse(new Uint8Array(bytes), { headers: { "content-type": "application/pdf" } });

/**
 * A framework-style error body `{ message, errors? }` at an HTTP error status.
 * This is the REAL shape observed (read-only) from the receipt host — e.g. a 404
 * route-model-binding failure when the company isn't enrolled for e-invoice.
 */
export const rframeworkError = (message: string, status = 404, errors?: Record<string, unknown>) =>
  HttpResponse.json(errors ? { message, errors } : { message }, { status });
