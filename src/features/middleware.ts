/**
 * Middleware functions for request processing
 */

import { settings } from "#db/settings.ts";
import { encodeBody } from "#routes/response.ts";
import { ASSET_CDN_ORIGIN } from "#shared/asset-paths.ts";
import {
  getEmbedHosts,
  isBotpoisonEnabled,
  isSecureMode,
} from "#shared/config.ts";
import { buildFrameAncestors } from "#shared/embed-hosts.ts";
import { paymentProviderMode } from "#shared/payment-provider-status.ts";
import { providerCheckoutFormOrigins } from "#shared/payment-providers.ts";
import type { PaymentProviderType } from "#types";

/**
 * Security headers for all responses
 */
const BASE_SECURITY_HEADERS: Record<string, string> = {
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
};

/** Payment config for CSP header construction */
export type PaymentCspConfig = {
  provider: PaymentProviderType | null;
  sandbox?: boolean | undefined;
};

/**
 * Build CSP header value
 * Non-embeddable pages get frame-ancestors 'none' to prevent clickjacking.
 * Embeddable pages omit frame-ancestors here; it's added by applySecurityHeaders
 * if embed host restrictions are configured.
 * Every provider uses a server-side redirect flow rather than an embedded SDK,
 * so form-action is the only directive that names provider hosts. It takes
 * them from the provider registry.
 * When Botpoison is enabled, connect-src allows the contact form's browser
 * widget to reach the Botpoison challenge API.
 * img-src additionally allows OpenStreetMap tiles — the attendee Logistics
 * tab's map loads its tile images straight from tile.openstreetmap.org.
 */
export const buildCspHeader = (
  embeddable: boolean,
  payment?: PaymentCspConfig,
  botpoisonEnabled = false,
  assetCdnOrigin: string | null = ASSET_CDN_ORIGIN,
): string => {
  const directives = [
    "default-src 'self'",
    "img-src 'self' https://tile.openstreetmap.org",
    "base-uri 'self'",
    "object-src 'none'",
  ];

  if (assetCdnOrigin) {
    directives.push(
      `script-src 'self' ${assetCdnOrigin}`,
      `style-src 'self' ${assetCdnOrigin}`,
    );
  }

  if (botpoisonEnabled) {
    directives.push("connect-src 'self' https://api.botpoison.com");
  }

  // The buyer's form posts straight to the provider's hosted checkout, so the
  // policy must name that provider's origins or the browser blocks the
  // redirect. The registry declares them, so a new provider cannot reach here
  // and silently get a policy that blocks its own checkout.
  const provider = payment?.provider ?? null;
  const checkoutOrigins =
    provider === null
      ? []
      : providerCheckoutFormOrigins(provider, payment?.sandbox === true);
  directives.push(["form-action 'self'", ...checkoutOrigins].join(" "));

  if (!embeddable) {
    directives.unshift("frame-ancestors 'none'");
  }
  return directives.join("; ");
};

/**
 * Get security headers for a response
 */
export const getSecurityHeaders = (
  embeddable: boolean,
  csp = buildCspHeader(embeddable),
): Record<string, string> => ({
  ...BASE_SECURITY_HEADERS,
  ...(!embeddable && { "x-frame-options": "DENY" }),
  ...(embeddable && { "x-robots-tag": "index, follow" }),
  ...(isSecureMode() && {
    "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  }),
  "content-security-policy": csp,
});

/** One slug: letter/number runs joined by single hyphens or underscores. */
const SLUG = "[a-z0-9]+(?:[-_][a-z0-9]+)*";

/** Matches /ticket/ with one or more slugs separated by + */
const EMBEDDABLE_PATH = new RegExp(`^/ticket/${SLUG}(?:\\+${SLUG})*$`);

/**
 * Check if a path is embeddable (public ticket pages only)
 * Paths are normalized to strip trailing slashes
 */
export const isEmbeddablePath = (path: string): boolean =>
  EMBEDDABLE_PATH.test(path);

/**
 * Check if path is a webhook endpoint that accepts JSON
 */
export const isWebhookPath = (path: string): boolean =>
  path === "/payment/webhook" || path === "/sms/webhook";

/** Pattern matching scan API paths (the scanner posts JSON check-ins) */
const SCAN_API_PATTERN = /^\/admin\/listing\/\d+\/scan$/;

/** Pattern for public API paths */
const API_PATH_PATTERN = /^\/api\//;

/** Pattern for Apple Wallet web service paths (PassKit protocol) */
const WALLET_WEBSERVICE_PATTERN = /^\/v1\//;

/**
 * Check if path is a JSON API endpoint. The patterns live here so this
 * always-loaded middleware never drags route modules into boot for a regex.
 */
export const isJsonApiPath = (path: string): boolean =>
  SCAN_API_PATTERN.test(path) ||
  API_PATH_PATTERN.test(path) ||
  WALLET_WEBSERVICE_PATTERN.test(path);

/**
 * Validate Content-Type for POST requests
 * Returns true if the request is valid (not a POST, or has correct Content-Type)
 * Webhook endpoints accept application/json, all others require form-urlencoded
 */
/** The request's Content-Type header, lowercased — HTTP header values are
 * case-insensitive, so every caller matches casings uniformly. */
export const lowerContentType = (request: Request): string =>
  (request.headers.get("content-type") ?? "").toLowerCase();

export const isValidContentType = (request: Request, path: string): boolean => {
  if (request.method !== "POST") {
    return true;
  }
  // The inter-instance credentials endpoint carries no body and authenticates
  // via a bearer key, so there is nothing to CSRF-protect.
  if (path === "/instance/site-credentials") {
    return true;
  }
  const contentType = lowerContentType(request);

  // Webhook and JSON API endpoints accept JSON
  if (isWebhookPath(path) || isJsonApiPath(path)) {
    return contentType.startsWith("application/json");
  }

  // All other POST endpoints require form-urlencoded or multipart (for file uploads)
  return (
    contentType.startsWith("application/x-www-form-urlencoded") ||
    contentType.startsWith("multipart/form-data")
  );
};

/**
 * Create Content-Type rejection response
 */
export const contentTypeRejectionResponse = (): Response =>
  new Response(encodeBody("Bad Request: Invalid Content-Type"), {
    headers: {
      "content-type": "text/plain",
      ...getSecurityHeaders(false),
    },
    status: 400,
  });

/** Tracking parameters added by social media and ad platforms */
const TRACKING_PARAMS = [
  "fbclid",
  "gclid",
  "gad_source",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
];

/** Check if a query parameter key is a tracking parameter */
const isTrackingParam = (key: string): boolean => TRACKING_PARAMS.includes(key);

/**
 * Get clean URL path with tracking parameters stripped.
 * Returns the clean path (preserving non-tracking query params) or null if no stripping needed.
 */
export const getCleanUrl = (url: URL): string | null => {
  let hasTracking = false;
  for (const key of url.searchParams.keys()) {
    if (isTrackingParam(key)) {
      hasTracking = true;
      break;
    }
  }
  if (!hasTracking) return null;

  const clean = new URLSearchParams();
  for (const [key, value] of url.searchParams.entries()) {
    if (!isTrackingParam(key)) {
      clean.append(key, value);
    }
  }
  const search = clean.toString();
  return search ? `${url.pathname}?${search}` : url.pathname;
};

/**
 * Apply security headers to a response.
 * Mutates headers in-place to avoid re-reading the response body, which
 * intermittently fails with "error decoding response body" on Bunny Edge.
 * For embeddable pages, fetches embed host restrictions and adds frame-ancestors.
 * Adds Cache-Control: private, no-store to dynamic responses (those without
 * an explicit cache-control header) to prevent CDN caching issues.
 */
export const applySecurityHeaders = async (
  response: Response,
  embeddable: boolean,
): Promise<Response> => {
  const provider = settings.paymentProvider;
  const sandbox =
    provider !== null && paymentProviderMode(provider) === "sandbox";
  const baseCsp = buildCspHeader(
    embeddable,
    { provider, sandbox },
    isBotpoisonEnabled(),
  );
  const frameAncestors = embeddable
    ? buildFrameAncestors(await getEmbedHosts())
    : null;
  const csp = frameAncestors ? `${frameAncestors}; ${baseCsp}` : baseCsp;
  const securityHeaders = getSecurityHeaders(embeddable, csp);

  // Check before setting security headers (they don't include cache-control)
  const hasCacheControl = response.headers.has("cache-control");

  for (const [key, value] of Object.entries(securityHeaders)) {
    response.headers.set(key, value);
  }

  // Override x-robots-tag for hidden listings (signal header set by route handlers)
  if (response.headers.has("x-robots-noindex")) {
    response.headers.set("x-robots-tag", "noindex, nofollow");
    response.headers.delete("x-robots-noindex");
  }

  // Prevent CDN from caching dynamic responses — static assets already set
  // their own cache-control (e.g. "public, max-age=31536000, immutable")
  if (!hasCacheControl) {
    response.headers.set("cache-control", "private, no-store");
  }

  return response;
};
