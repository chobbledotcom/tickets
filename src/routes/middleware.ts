/**
 * Middleware functions for request processing
 */

/**
 * Security headers for all responses
 */
const BASE_SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

/**
 * Get security headers for a response
 * @param embeddable - Whether the page should be embeddable in iframes
 */
export const getSecurityHeaders = (
  embeddable: boolean,
): Record<string, string> => {
  if (embeddable) {
    return {
      ...BASE_SECURITY_HEADERS,
    };
  }
  return {
    ...BASE_SECURITY_HEADERS,
    "x-frame-options": "DENY",
    "content-security-policy": "frame-ancestors 'none'",
  };
};

/**
 * Check if a path is embeddable (public ticket pages only)
 */
export const isEmbeddablePath = (path: string): boolean =>
  /^\/ticket\/\d+$/.test(path);

/**
 * Validate origin for CORS protection on POST requests
 * Returns true if the request should be allowed
 */
export const isValidOrigin = (request: Request): boolean => {
  const method = request.method;

  // Only check POST requests
  if (method !== "POST") {
    return true;
  }

  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");

  // If no origin header, check referer (some browsers may not send origin)
  const requestUrl = new URL(request.url);
  const requestHost = requestUrl.host;

  // If origin is present, it must match
  if (origin) {
    const originUrl = new URL(origin);
    return originUrl.host === requestHost;
  }

  // Fallback to referer check
  if (referer) {
    const refererUrl = new URL(referer);
    return refererUrl.host === requestHost;
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
