import type { BaseProviderConfig } from "@paid-tw/einvoice";

/**
 * Simpany config. Auth is a JWT bearer obtained from `POST /v1/login
 * { account, password }` (30-day TTL). The SAME token authorizes both hosts:
 * the auth/account host (`api.simpany.co`) and the e-invoice "receipt" host
 * (`member2.simpany.co`). The client logs in lazily, caches the token, and
 * re-logs in once on a 401.
 *
 * NOTE: Simpany publishes no developer API. The auth layer is verified against
 * the live API; the e-invoice operation details were compiled by hand and may be
 * inaccurate — they are UNVERIFIED against a live e-invoice-enabled account.
 */
export interface SimpanyConfig extends BaseProviderConfig {
  /** Login account (the member email). Optional when a {@link token} is supplied. */
  account?: string;
  /**
   * Login password (plaintext). Sent over TLS to `POST /v1/login`. Optional when
   * a pre-obtained {@link token} is supplied.
   */
  password?: string;
  /** A pre-obtained JWT, to skip the login round-trip (e.g. injected from a vault). */
  token?: string;
  /**
   * The company id to scope requests to (`/c/{companyId}/...`). Omit to let the
   * client resolve it from `GET /v1/me` — the sole company, or the one matching
   * {@link companyUbn}.
   */
  companyId?: string | number;
  /**
   * When {@link companyId} is unset and `/v1/me` returns several companies, pick
   * the one whose 統一編號 matches this. Ignored when `companyId` is set.
   */
  companyUbn?: string;
  /** Override the e-invoice ("receipt") API base. Defaults to {@link SIMPANY_RECEIPT_BASE_URL}. */
  receiptBaseUrl?: string;
  /** Validate the built payload locally before sending (default `true`). */
  validatePayload?: boolean;
}

/** Auth/account API base (`baseUrl` overrides it, e.g. for a proxy). */
export const SIMPANY_BASE_URL = {
  PRODUCTION: "https://api.simpany.co/v1",
} as const;

/** E-invoice ("receipt") API base (`receiptBaseUrl` overrides it). */
export const SIMPANY_RECEIPT_BASE_URL = {
  PRODUCTION: "https://member2.simpany.co/api/v1",
} as const;

export function resolveBaseUrl(config: SimpanyConfig): string {
  return config.baseUrl ?? SIMPANY_BASE_URL.PRODUCTION;
}

export function resolveReceiptBaseUrl(config: SimpanyConfig): string {
  return config.receiptBaseUrl ?? SIMPANY_RECEIPT_BASE_URL.PRODUCTION;
}
