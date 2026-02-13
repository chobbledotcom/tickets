/**
 * Middleware functions for request processing
 */

import { compact } from "#fp";
import { getAllowedDomain, getEmbedHosts } from "#lib/config.ts";
import { buildFrameAncestors } from "#lib/embed-hosts.ts";
import { SCAN_API_PATTERN } from "#routes/admin/scanner.ts";

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

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
