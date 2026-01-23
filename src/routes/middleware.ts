/**
 * Middleware functions for request processing
 */

import { getAllowedDomain } from "#lib/config.ts";

/** Cached allowed domain (read once at startup) */
const ALLOWED_DOMAIN = getAllowedDomain();

/**
 * Security headers for all responses
 */
const BASE_SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

/**
 * Build CSP header value
 * Restricts resources to self and prevents clickjacking for non-embeddable pages
 */
const buildCspHeader = (embeddable: boolean): string => {
  const directives: string[] = [];

  // Frame ancestors - prevent clickjacking (except for embeddable pages)
  if (!embeddable) {
    directives.push("frame-ancestors 'none'");
  }

  // Restrict resource loading to self (prevents loading from unexpected domains)
  directives.push("default-src 'self'");
  directives.push("style-src 'self' 'unsafe-inline'"); // Allow inline styles
  directives.push("script-src 'self' 'unsafe-inline'"); // Allow inline scripts
  directives.push("form-action 'self'"); // Restrict form submissions to self

  return directives.join("; ");
};

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
 */
export const isEmbeddablePath = (path: string): boolean =>
  /^\/ticket\/\d+$/.test(path);

/**
 * Validate origin for CORS protection on POST requests
 * Returns true if the request should be allowed
 *
 * Validates against ALLOWED_DOMAIN (build-time config).
 * This prevents attacks where an attacker proxies the app through their own domain.
 */
export const isValidOrigin = (request: Request): boolean => {
  // Only check POST requests
  if (request.method !== "POST") {
    return true;
  }

  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");

  // If origin is present, it must match allowed domain
  if (origin) {
    const originUrl = new URL(origin);
    return originUrl.host === ALLOWED_DOMAIN;
  }

  // Fallback to referer check
  if (referer) {
    const refererUrl = new URL(referer);
    return refererUrl.host === ALLOWED_DOMAIN;
  }

  // If neither origin nor referer, reject (could be a direct form submission from another site)
  return false;
};

/**
 * Validate Content-Type for POST requests
 * Returns true if the request is valid (not a POST, or has correct Content-Type)
 */
export const isValidContentType = (request: Request): boolean => {
  if (request.method !== "POST") {
    return true;
  }
  const contentType = request.headers.get("content-type") || "";
  // Accept application/x-www-form-urlencoded (with optional charset)
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
 * Create CORS rejection response
 */
export const corsRejectionResponse = (): Response =>
  new Response("Forbidden: Cross-origin requests not allowed", {
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
