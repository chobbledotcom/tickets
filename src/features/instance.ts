/**
 * Inter-instance machine endpoint (builder / main instance only).
 *
 * `POST /instance/site-credentials`, bearing `MAIN_INSTANCE_KEY`, returns the
 * database credentials for every built site, so the upgrade Action can back
 * each site up before deploying to it without GitHub holding per-site script
 * ids or tokens.
 *
 * `?tier=alpha|beta|release` (default `release`) returns only the sites whose
 * own channel accepts that tier: release reaches every site, beta reaches beta
 * and alpha, alpha only alpha. An unrecognised tier is a 400, and the default
 * keeps a caller that omits it seeing the whole fleet.
 *
 * The route is disabled unless MAIN_INSTANCE_KEY is set, so a plain instance
 * 404s rather than advertising it, and the key is compared in constant time.
 * Each token returned is that site's own FULL-ACCESS credential, so treat the
 * response as write-capable production secrets even though callers only read.
 * The per-site DB_ENCRYPTION_KEY is never included, leaving PII unreadable to
 * whoever holds the response. It is a POST so the key and the response stay
 * out of access-log query strings.
 */

import { apiErrorResponse } from "#routes/api/cors.ts";
import { jsonResponse } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { getMainInstanceKey, isInstanceApiEnabled } from "#shared/config.ts";
import { constantTimeEqual } from "#shared/crypto/utils.ts";
import {
  DEFAULT_UPDATE_TIER,
  isUpdateTier,
  siteAcceptsDeployTier,
} from "#shared/db/built-sites/types.ts";
import { builtSites } from "#shared/db/built-sites.ts";

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
  if (!isInstanceApiEnabled()) return apiErrorResponse("not_found", 404);

  if (!constantTimeEqual(bearerToken(request), getMainInstanceKey())) {
    return apiErrorResponse("unauthorized", 401);
  }

  // The deploy tier being published. Absent/empty ⇒ release (reaches every
  // site, preserving the pre-tier "whole fleet" behaviour); a junk value is a
  // 400 rather than a silent fall-through that would deploy to the wrong set.
  const deployTier =
    new URL(request.url).searchParams.get("tier") || DEFAULT_UPDATE_TIER;
  if (!isUpdateTier(deployTier)) {
    return apiErrorResponse("invalid_tier");
  }

  const sites = await builtSites.getAll();
  const credentials: SiteCredentials[] = sites
    .filter(
      (site) =>
        site.hostingId &&
        site.hostingProvider === "bunny" &&
        site.dbUrl &&
        site.dbToken,
    )
    .filter((site) => siteAcceptsDeployTier(site.updates, deployTier))
    .map((site) => ({
      dbToken: site.dbToken,
      dbUrl: site.dbUrl,
      name: site.name,
      scriptId: site.hostingId,
    }));

  // Echo the applied tier so a caller can confirm the server actually filtered:
  // a pre-tier build ignores ?tier= and omits this, letting the canary workflow
  // fail closed rather than fan a non-release deploy out to the whole fleet.
  return jsonResponse({ sites: credentials, tier: deployTier });
};

export const instanceRoutes = defineRoutes({
  "POST /instance/site-credentials": handleSiteCredentials,
});
