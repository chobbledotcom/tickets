/**
 * Inter-instance machine endpoint (builder / main instance only).
 *
 * `POST /instance/site-credentials` with `Authorization: Bearer <MAIN_INSTANCE_KEY>`
 * returns the read-only database credentials for every built site, so the
 * upgrade GitHub Action can back each site up (to the builder's own storage)
 * before deploying to it — without storing per-site script ids or DB tokens in
 * GitHub.
 *
 * The caller passes the release tier it is publishing as `?tier=alpha|beta|release`
 * (default `release`), and only the sites whose own channel accepts that tier are
 * returned: a release deploy reaches every site, a beta deploy reaches beta +
 * alpha sites, an alpha deploy only alpha sites. Defaulting to `release` keeps a
 * caller that omits the tier (e.g. the single-site backup action) seeing the
 * whole fleet, exactly as before. An unrecognised tier is a 400.
 *
 * Security posture:
 * - Disabled unless MAIN_INSTANCE_KEY is set (a plain instance never exposes it,
 *   and a disabled builder returns 404 rather than advertising the route).
 * - The bearer key is compared in constant time.
 * - Only the per-site READ-ONLY db token is returned — no write access, and the
 *   per-site DB_ENCRYPTION_KEY is never stored here, so field-level PII stays
 *   unreadable to whoever holds the response.
 * - POST so the key and the response never land in access-log query strings;
 *   served over HTTPS at the edge. The tier is a non-secret filter, so it rides
 *   in the query string.
 */

import { jsonResponse } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { getMainInstanceKey, isInstanceApiEnabled } from "#shared/config.ts";
import { constantTimeEqual } from "#shared/crypto/utils.ts";
import {
  DEFAULT_UPDATE_TIER,
  getAllBuiltSites,
  isUpdateTier,
  siteAcceptsDeployTier,
} from "#shared/db/built-sites.ts";

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

  // The deploy tier being published. Absent/empty ⇒ release (reaches every
  // site, preserving the pre-tier "whole fleet" behaviour); a junk value is a
  // 400 rather than a silent fall-through that would deploy to the wrong set.
  const deployTier =
    new URL(request.url).searchParams.get("tier") || DEFAULT_UPDATE_TIER;
  if (!isUpdateTier(deployTier)) {
    return jsonResponse({ error: "invalid_tier" }, 400);
  }

  const sites = await getAllBuiltSites();
  const credentials: SiteCredentials[] = sites
    .filter((site) => site.bunnyScriptId && site.dbUrl && site.dbToken)
    .filter((site) => siteAcceptsDeployTier(site.updates, deployTier))
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
