/**
 * Middleware functions for request processing
 */

import { compact } from "#fp";
import { getAllowedDomain, getEmbedHosts } from "#lib/config.ts";
import { buildFrameAncestors } from "#lib/embed-hosts.ts";
import { SCAN_API_PATTERN } from "#routes/admin/scanner.ts";
import { cloneResponse } from "#routes/utils.ts";

/**
 * Security headers for all responses
 */
const BASE_SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-robots-tag": "noindex, nofollow",
};

/**
 * Build CSP header value
 * Non-embeddable pages get frame-ancestors 'none' to prevent clickjacking.
 * Embeddable pages omit frame-ancestors here; it's added by applySecurityHeaders
 * if embed host restrictions are configured.
 */
const buildCspHeader = (embeddable: boolean): string =>
  compact([
    !embeddable && "frame-ancestors 'none'",
    "default-src 'self'",
    "style-src 'self'",
    "script-src 'self' https://*.squarecdn.com https://js.squareup.com",
    "connect-src 'self' https://pci-connect.squareup.com",
    "form-action 'self' https://checkout.stripe.com",
  ]).join("; ");

/**
 * Get security headers for a response
 */
export const getSecurityHeaders = (
  embeddable: boolean,
): Record<string, string> => ({
  ...BASE_SECURITY_HEADERS,
  ...(!embeddable && { "x-frame-options": "DENY" }),
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
 * Normalize a hostname for comparison:
 * - Strip port (Host header may include :443 or :3000)
 * - Lowercase (DNS names are case-insensitive)
 * - Strip trailing dot (FQDN notation: "example.com." === "example.com")
 */
export const normalizeHostname = (host: string): string => {
  const colonIndex = host.indexOf(":");
  const withoutPort = colonIndex === -1 ? host : host.slice(0, colonIndex);
  const lowered = withoutPort.toLowerCase();
  return lowered.endsWith(".") ? lowered.slice(0, -1) : lowered;
};

/**
 * Validate request domain against ALLOWED_DOMAIN.
 * Checks the Host header to prevent the app being served through unauthorized proxies.
 * Falls back to the request URL hostname for HTTP/2 requests or proxied
 * environments (e.g. Facebook in-app browser) where the Host header may be
 * absent or rewritten.
 * Returns true if the request should be allowed.
 */
export const isValidDomain = (request: Request): boolean => {
  const allowed = normalizeHostname(getAllowedDomain());

  // Check Host header (standard for HTTP/1.1)
  const host = request.headers.get("host");
  if (host && normalizeHostname(host) === allowed) {
    return true;
  }

  // Fallback: check the request URL hostname (covers HTTP/2 :authority
  // and CDN-rewritten requests where the Host header is missing or altered)
  return normalizeHostname(new URL(request.url).host) === allowed;
};

/**
 * Check if path is a webhook endpoint that accepts JSON
 */
export const isWebhookPath = (path: string): boolean =>
  path === "/payment/webhook";

/**
 * Check if path is a JSON API endpoint.
 * Patterns are exported from their respective route modules.
 */
export const isJsonApiPath = (path: string): boolean =>
  SCAN_API_PATTERN.test(path);

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
  return contentType.startsWith("application/x-www-form-urlencoded") ||
    contentType.startsWith("multipart/form-data");
};

/**
 * Create Content-Type rejection response
 */
export const contentTypeRejectionResponse = (): Response =>
  new Response("Bad Request: Invalid Content-Type", {
    status: 400,
    headers: {
      "content-type": "text/plain",
      ...getSecurityHeaders(false),
    },
  });

/**
 * Create domain rejection response
 */
export const domainRejectionResponse = (): Response =>
  new Response("Forbidden: Invalid domain", {
    status: 403,
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
const isTrackingParam = (key: string): boolean =>
  TRACKING_PARAMS.includes(key);

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
 * Apply security headers to a response
 * For embeddable pages, fetches embed host restrictions and adds frame-ancestors.
 */
export const applySecurityHeaders = async (
  response: Response,
  embeddable: boolean,
): Promise<Response> => {
  const headers = new Headers(response.headers);
  const securityHeaders = getSecurityHeaders(embeddable);

  for (const [key, value] of Object.entries(securityHeaders)) {
    headers.set(key, value);
  }

  if (embeddable) {
    const frameAncestors = buildFrameAncestors(await getEmbedHosts());
    if (frameAncestors) {
      headers.set("content-security-policy", `${frameAncestors}; ${headers.get("content-security-policy")}`);
    }
  }

  return cloneResponse(response, headers);
};
