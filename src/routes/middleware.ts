/**
 * Middleware functions for request processing
 */

import { getEffectiveDomain, getEmbedHosts } from "#lib/config.ts";
import { settings } from "#lib/db/settings.ts";
import { buildFrameAncestors } from "#lib/embed-hosts.ts";
import { SCAN_API_PATTERN } from "#routes/admin/scanner.ts";
import { encodeBody } from "#routes/utils.ts";

/**
 * Security headers for all responses
 */
const BASE_SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-robots-tag": "noindex, nofollow",
};

/** Payment config for CSP header construction */
export type PaymentCspConfig = {
  provider: "stripe" | "square" | null;
  sandbox?: boolean;
};

/**
 * Build CSP header value
 * Non-embeddable pages get frame-ancestors 'none' to prevent clickjacking.
 * Embeddable pages omit frame-ancestors here; it's added by applySecurityHeaders
 * if embed host restrictions are configured.
 * Payment-specific directives are included only when a provider is configured.
 * Both Stripe and Square use server-side redirect flows (not embedded SDKs),
 * so only form-action needs provider-specific domains.
 */
export const buildCspHeader = (
  embeddable: boolean,
  payment?: PaymentCspConfig,
): string => {
  const directives = ["default-src 'self'"];

  if (payment?.provider === "square") {
    const sq = payment.sandbox
      ? "https://connect.squareupsandbox.com https://pci-connect.squareupsandbox.com https://api.squareupsandbox.com"
      : "https://connect.squareup.com https://pci-connect.squareup.com https://api.squareup.com";
    directives.push(
      `form-action 'self' https://square.link https://checkout.square.site https://*.squarecdn.com https://geoissuer.cardinalcommerce.com ${sq}`,
    );
  } else if (payment?.provider === "stripe") {
    directives.push("form-action 'self' https://checkout.stripe.com");
  } else {
    directives.push("form-action 'self'");
  }

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
): Record<string, string> => ({
  ...BASE_SECURITY_HEADERS,
  ...(!embeddable && { "x-frame-options": "DENY" }),
  ...(embeddable && { "x-robots-tag": "index, follow" }),
  ...(getEffectiveDomain() !== "localhost" && {
    "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  }),
  "content-security-policy": buildCspHeader(embeddable),
});

/** Single slug: alphanumeric segments joined by hyphens (e.g. "a1b2" or "my-event") */
const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";

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
  path === "/payment/webhook";

/** Pattern for public API paths */
const API_PATH_PATTERN = /^\/api\//;

/** Pattern for Apple Wallet web service paths (PassKit protocol) */
const WALLET_WEBSERVICE_PATTERN = /^\/v1\//;

/**
 * Check if path is a JSON API endpoint.
 * Patterns are exported from their respective route modules.
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
export const isValidContentType = (request: Request, path: string): boolean => {
  if (request.method !== "POST") {
    return true;
  }
  const contentType = request.headers.get("content-type") || "";

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
    status: 400,
    headers: {
      "content-type": "text/plain",
      ...getSecurityHeaders(false),
    },
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

/** Check if any search params are tracking parameters */
const hasTrackingParams = (searchParams: URLSearchParams): boolean => {
  for (const key of searchParams.keys()) {
    if (isTrackingParam(key)) return true;
  }
  return false;
};

/** Build clean URLSearchParams with tracking params removed */
const stripTrackingParams = (searchParams: URLSearchParams): URLSearchParams => {
  const clean = new URLSearchParams();
  for (const [key, value] of searchParams.entries()) {
    if (!isTrackingParam(key)) clean.append(key, value);
  }
  return clean;
};

/**
 * Get clean URL path with tracking parameters stripped.
 * Returns the clean path (preserving non-tracking query params) or null if no stripping needed.
 */
export const getCleanUrl = (url: URL): string | null => {
  if (!hasTrackingParams(url.searchParams)) return null;
  const search = stripTrackingParams(url.searchParams).toString();
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
  const securityHeaders = getSecurityHeaders(embeddable);

  // Check before setting security headers (they don't include cache-control)
  const hasCacheControl = response.headers.has("cache-control");

  for (const [key, value] of Object.entries(securityHeaders)) {
    response.headers.set(key, value);
  }

  // Rebuild CSP with payment-provider-specific directives
  const provider = settings.paymentProvider;
  const sandbox = provider === "square" ? settings.square.sandbox : undefined;
  response.headers.set(
    "content-security-policy",
    buildCspHeader(embeddable, { provider, sandbox }),
  );

  // Override x-robots-tag for hidden events (signal header set by route handlers)
  if (response.headers.has("x-robots-noindex")) {
    response.headers.set("x-robots-tag", "noindex, nofollow");
    response.headers.delete("x-robots-noindex");
  }

  // Prevent CDN from caching dynamic responses — static assets already set
  // their own cache-control (e.g. "public, max-age=31536000, immutable")
  if (!hasCacheControl) {
    response.headers.set("cache-control", "private, no-store");
  }

  if (embeddable) {
    const frameAncestors = buildFrameAncestors(await getEmbedHosts());
    if (frameAncestors) {
      const csp = response.headers.get("content-security-policy");
      response.headers.set(
        "content-security-policy",
        `${frameAncestors}; ${csp}`,
      );
    }
  }

  return response;
};
