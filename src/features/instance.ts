/**
 * Inter-instance machine endpoint (builder / main instance only).
 *
 * `POST /instance/site-credentials` with `Authorization: Bearer <MAIN_INSTANCE_KEY>`
 * returns the read-only database credentials for every built site, so the
 * upgrade GitHub Action can back each site up (to the builder's own storage)
 * before deploying to it — without storing per-site script ids or DB tokens in
 * GitHub.
 *
 * Security posture:
 * - Disabled unless MAIN_INSTANCE_KEY is set (a plain instance never exposes it,
 *   and a disabled builder returns 404 rather than advertising the route).
 * - The bearer key is compared in constant time.
 * - Only the per-site READ-ONLY db token is returned — no write access, and the
 *   per-site DB_ENCRYPTION_KEY is never stored here, so field-level PII stays
 *   unreadable to whoever holds the response.
 * - POST so the key and the response never land in access-log query strings;
 *   served over HTTPS at the edge.
 */

import { jsonResponse } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { getMainInstanceKey, isInstanceApiEnabled } from "#shared/config.ts";
import { constantTimeEqual } from "#shared/crypto/utils.ts";
import { getAllBuiltSites } from "#shared/db/built-sites.ts";

/** Extract the bearer token from the Authorization header (empty if absent). */
const bearerToken = (request: Request): string => {
  const auth = request.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
};

/** One built site's machine-readable upgrade credentials. */
type SiteCredentials = {
  name: string;
  scriptId: string;
  dbUrl: string;
  dbToken: string;
};

const handleSiteCredentials = async (request: Request): Promise<Response> => {
  // Off unless configured — 404 so a non-builder/disabled instance doesn't
  // even reveal that the endpoint exists.
  if (!isInstanceApiEnabled()) return jsonResponse({ error: "not_found" }, 404);

  if (!constantTimeEqual(bearerToken(request), getMainInstanceKey())) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const sites = await getAllBuiltSites();
  const credentials: SiteCredentials[] = sites
    .filter((site) => site.bunnyScriptId && site.dbUrl && site.dbToken)
    .map((site) => ({
      dbToken: site.dbToken,
      dbUrl: site.dbUrl,
      name: site.name,
      scriptId: site.bunnyScriptId,
    }));

  return jsonResponse({ sites: credentials });
};

export const instanceRoutes = defineRoutes({
  "POST /instance/site-credentials": handleSiteCredentials,
});
