/**
 * URL, cookie, and request parsing utilities
 */

import { getCookies } from "@std/http/cookie";

/**
 * Parse cookies from request
 */
export const parseCookies = (request: Request): Map<string, string> =>
  new Map(Object.entries(getCookies(request.headers)) as [string, string][]);

/**
 * Get base URL from request
 */
export const getBaseUrl = (request: Request): string => {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
};

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

import { normalizePath } from "#shared/path.ts";
