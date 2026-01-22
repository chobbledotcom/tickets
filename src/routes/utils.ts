/**
 * Shared utilities for route handlers
 */

import { constantTimeEqual, generateSecureToken } from "#lib/crypto.ts";
import { deleteSession, getSession } from "#lib/db.ts";
import type { ServerContext } from "./types.ts";

// Re-export for use by other route modules
export { generateSecureToken };

/**
 * Get client IP from request
 * Note: This server runs directly on edge, not behind a proxy,
 * so we use the direct connection IP from the server context.
 * The IP is passed via the server's requestIP() in Bun.serve.
 */
export const getClientIp = (
  request: Request,
  server?: ServerContext,
): string => {
  // Use Bun's server.requestIP() if available
  if (server?.requestIP) {
    const info = server.requestIP(request);
    if (info?.address) {
      return info.address;
    }
  }
  // Fallback for testing or when server context not available
  return "direct";
};

/**
 * Parse cookies from request
 */
export const parseCookies = (request: Request): Map<string, string> => {
  const cookies = new Map<string, string>();
  const header = request.headers.get("cookie");
  if (!header) return cookies;

  for (const part of header.split(";")) {
    const [key, value] = part.trim().split("=");
    if (key && value) {
      cookies.set(key, value);
    }
  }
  return cookies;
};

/**
 * Get authenticated session if valid
 * Returns null if not authenticated
 */
export const getAuthenticatedSession = async (
  request: Request,
): Promise<{ token: string; csrfToken: string } | null> => {
  const cookies = parseCookies(request);
  const token = cookies.get("session");
  if (!token) return null;

  const session = await getSession(token);
  if (!session) return null;

  if (session.expires < Date.now()) {
    await deleteSession(token);
    return null;
  }

  return { token, csrfToken: session.csrf_token };
};

/**
 * Check if request has valid session
 */
export const isAuthenticated = async (request: Request): Promise<boolean> => {
  return (await getAuthenticatedSession(request)) !== null;
};

/**
 * Validate CSRF token using constant-time comparison
 */
export const validateCsrfToken = (
  expected: string,
  actual: string,
): boolean => {
  return constantTimeEqual(expected, actual);
};

/**
 * Create HTML response
 */
export const htmlResponse = (html: string, status = 200): Response =>
  new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

/**
 * Create redirect response
 */
export const redirect = (url: string, cookie?: string): Response => {
  const headers: HeadersInit = { location: url };
  if (cookie) {
    headers["set-cookie"] = cookie;
  }
  return new Response(null, { status: 302, headers });
};

/**
 * Parse form data from request
 */
export const parseFormData = async (
  request: Request,
): Promise<URLSearchParams> => {
  const text = await request.text();
  return new URLSearchParams(text);
};

/**
 * Get base URL from request
 */
export const getBaseUrl = (request: Request): string => {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
};
