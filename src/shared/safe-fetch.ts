/**
 * Fetch helpers for admin-supplied server-side URLs.
 *
 * These intentionally disable the runtime's automatic redirect handling so each
 * redirect hop can be validated before the server makes the next request.
 */

import { type FetchResult, fetchText } from "#shared/fetch.ts";
import { isSafeServerFetchUrl } from "#shared/url-safety.ts";

const REDIRECT_STATUSES = [301, 302, 303, 307, 308] as const;
const MAX_SAFE_REDIRECTS = 5;

const isRedirect = (status: number): boolean =>
  REDIRECT_STATUSES.includes(status as (typeof REDIRECT_STATUSES)[number]);

const resolveRedirectUrl = (location: string, currentUrl: string): string => {
  try {
    return new URL(location, currentUrl).toString();
  } catch {
    throw new Error("Unsafe redirect URL");
  }
};

const manualRedirectInit = (init?: RequestInit): RequestInit => ({
  ...init,
  redirect: "manual",
});

/**
 * Fetch a URL that has already passed the server-fetch URL policy, following
 * redirects only after validating each hop against the same policy.
 */
export const fetchTextFollowingSafeRedirects = async (
  url: string,
  init?: RequestInit,
  fetchImpl: typeof fetchText = fetchText,
): Promise<FetchResult> => {
  let currentUrl = url;

  for (
    let redirectCount = 0;
    redirectCount <= MAX_SAFE_REDIRECTS;
    redirectCount++
  ) {
    if (!isSafeServerFetchUrl(currentUrl)) {
      throw new Error("Unsafe redirect URL");
    }

    const result = await fetchImpl(currentUrl, manualRedirectInit(init));
    if (!isRedirect(result.status)) return result;

    const location = result.headers.get("location");
    if (!location) return result;
    if (redirectCount === MAX_SAFE_REDIRECTS) {
      throw new Error("Too many redirects");
    }

    currentUrl = resolveRedirectUrl(location, currentUrl);
  }

  throw new Error("Too many redirects");
};
