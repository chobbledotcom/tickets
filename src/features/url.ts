/**
 * URL, cookie, and request parsing utilities
 */

import { getCookies } from "@std/http/cookie";
import type { ServerContext } from "#routes/types.ts";

/**
 * Parse cookies from request
 */
export const parseCookies = (request: Request): Map<string, string> =>
  new Map(Object.entries(getCookies(request.headers)) as [string, string][]);

/**
 * Get client IP from request
 * Note: This server runs directly on edge, not behind a proxy,
 * so we use the direct connection IP from the server context.
 */
export const getClientIp = (
  request: Request,
  server?: ServerContext,
): string => {
  // Use server.requestIP() if available
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
 * Get base URL from request
 */
export const getBaseUrl = (request: Request): string => {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
};

/**
 * Normalize path by stripping trailing slashes (except root "/")
 * This allows consistent path comparisons like "/admin" instead of checking both "/admin" and "/admin/"
 */
export const normalizePath = (path: string): string =>
  path !== "/" && path.endsWith("/") ? path.slice(0, -1) : path;

/**
 * Parse request URL and extract path/method
 * Paths are normalized to strip trailing slashes
 */
export const parseRequest = (
  request: Request,
): { url: URL; path: string; method: string } => {
  const url = new URL(request.url);
  return { method: request.method, path: normalizePath(url.pathname), url };
};

/**
 * Get search param from request URL
 */
export const getSearchParam = (request: Request, key: string): string => {
  const url = new URL(request.url);
  return url.searchParams.get(key) ?? "";
};
