/**
 * Fetch helpers for admin-supplied server-side URLs.
 *
 * These intentionally disable the runtime's automatic redirect handling so each
 * redirect hop can be checked before the server makes the next request. A hop
 * replays the body and credentials, so it must stay on the same origin.
 */

import { range } from "#fp";
import { type FetchResult, fetchText } from "#shared/fetch.ts";

const REDIRECT_STATUSES = [301, 302, 303, 307, 308] as const;
const MAX_SAFE_REDIRECTS = 5;

const isRedirect = (status: number): boolean =>
  REDIRECT_STATUSES.includes(status as (typeof REDIRECT_STATUSES)[number]);

const resolveRedirectUrl = (location: string, currentUrl: string): string => {
  const target = URL.parse(location, currentUrl);
  if (target?.origin !== new URL(currentUrl).origin) {
    throw new Error("Unsafe redirect URL");
  }
  return target.toString();
};

const manualRedirectInit = (init?: RequestInit): RequestInit => ({
  ...init,
  redirect: "manual",
});

/**
 * Fetch a URL that has already passed the server-fetch URL policy, following
 * same-origin redirects only. That policy reads only the scheme and the host, so
 * a hop on the same origin passes it too.
 */
export const fetchTextFollowingSafeRedirects = async (
  url: string,
  init?: RequestInit,
  fetchImpl: typeof fetchText = fetchText,
): Promise<FetchResult> => {
  let currentUrl = url;

  // One fetch for the original URL plus one per allowed redirect hop.
  for (const _hop of range(0, MAX_SAFE_REDIRECTS + 1)) {
    const result = await fetchImpl(currentUrl, manualRedirectInit(init));
    if (!isRedirect(result.status)) return result;

    const location = result.headers.get("location");
    if (!location) return result;

    currentUrl = resolveRedirectUrl(location, currentUrl);
  }
  throw new Error("Too many redirects");
};
