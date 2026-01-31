/**
 * Middleware functions for request processing
 */

import { compact } from "#fp";
import { getAllowedDomain } from "#lib/config.ts";

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
 * Restricts resources to self and prevents clickjacking for non-embeddable pages
 */
const buildCspHeader = (embeddable: boolean): string =>
  compact([
    // Frame ancestors - prevent clickjacking (except for embeddable pages)
    !embeddable && "frame-ancestors 'none'",
    // Restrict resource loading to self (prevents loading from unexpected domains)
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline'", // Allow inline styles
    "script-src 'self' 'unsafe-inline'", // Allow inline scripts
    "form-action 'self' https://checkout.stripe.com", // Restrict form submissions to self + Stripe checkout redirect
  ]).join("; ");

/**
 * Get security headers for a response
 * @param embeddable - Whether the page should be embeddable in iframes
 */
export const getSecurityHeaders = (
  embeddable: boolean,
): Record<string, string> => ({
  ...BASE_SECURITY_HEADERS,
  ...(!embeddable && { "x-frame-options": "DENY" }),
  "content-security-policy": buildCspHeader(embeddable),
});

/**
 * Check if a path is embeddable (public ticket pages only)
 * Paths are normalized to strip trailing slashes
 */
export const isEmbeddablePath = (path: string): boolean =>
  /^\/ticket\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path);

/**
 * Extract hostname from Host header (removes port if present)
 */
const getHostname = (host: string): string => {
  const colonIndex = host.indexOf(":");
  return colonIndex === -1 ? host : host.slice(0, colonIndex);
};

/**
 * Validate request domain against ALLOWED_DOMAIN.
 * Checks the Host header to prevent the app being served through unauthorized proxies.
 * Returns true if the request should be allowed.
 */
export const isValidDomain = (request: Request): boolean => {
  const host = request.headers.get("host");
  if (!host) {
    return false;
  }
  return getHostname(host) === getAllowedDomain();
};

/**
 * Check if path is a webhook endpoint that accepts JSON
 */
export const isWebhookPath = (path: string): boolean =>
  path === "/payment/webhook";

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

  // Webhook endpoints accept JSON
  if (isWebhookPath(path)) {
    return contentType.startsWith("application/json");
  }

  // All other POST endpoints require form-urlencoded
  return contentType.startsWith("application/x-www-form-urlencoded");
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

/**
 * Apply security headers to a response
 */
export const applySecurityHeaders = (
  response: Response,
  embeddable: boolean,
): Response => {
  const headers = new Headers(response.headers);
  const securityHeaders = getSecurityHeaders(embeddable);

  for (const [key, value] of Object.entries(securityHeaders)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
