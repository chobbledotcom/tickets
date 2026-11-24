/**
 * The redirect of a missing page. A visitor who asks for a page that is gone
 * gets a permanent redirect when an operator saved one for the page.
 */

import { redirectCount, redirectTargetOrNull } from "#db/redirects.ts";
import { permanentRedirectResponse } from "#routes/response.ts";
import {
  redirectKeyOfRequest,
  redirectsServe,
} from "#shared/redirect-paths.ts";

/** The permanent redirect for a missing page, or null when the page has none.
 *  Only a request that reads a page can follow a redirect. The lookup is
 *  skipped while no redirect exists, so a site without redirects pays no
 *  database request for a missing page. */
export const missingPageRedirectOrNull = async (
  path: string,
  method: string,
): Promise<Response | null> => {
  if (
    (method !== "GET" && method !== "HEAD") ||
    redirectCount() === 0 ||
    !redirectsServe(path)
  ) {
    return null;
  }
  const target = await redirectTargetOrNull(redirectKeyOfRequest(path));
  return target === null ? null : permanentRedirectResponse(target);
};
