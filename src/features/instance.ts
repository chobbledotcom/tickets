/**
 * `POST /instance/site-credentials` backs each built site up before its
 * deploy, without GitHub holding per-site tokens. Every call on an enabled
 * instance reports itself through the error path under its own code.
 * The key leaked once through a public workflow log.
 *
 * `?tier=alpha|beta|release` returns only sites whose channel accepts that
 * tier: release reaches every site, beta reaches beta and alpha, alpha only alpha.
 * Each token returned is that site's own FULL-ACCESS credential, so treat the
 * response as write-capable production secrets. It never holds
 * DB_ENCRYPTION_KEY, so the personal data stays unreadable.
 */

import { constantTimeEqual } from "#crypto/utils.ts";
import {
  DEFAULT_UPDATE_TIER,
  isUpdateTier,
  siteAcceptsDeployTier,
} from "#db/built-sites/types.ts";
import { builtSites } from "#db/built-sites.ts";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { jsonResponse } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { getMainInstanceKey, isInstanceApiEnabled } from "#shared/config.ts";
import { ErrorCode, logError } from "#shared/logger.ts";

/** True when the request presents the configured site key as a bearer token. */
const presentsInstanceKey = (request: Request): boolean => {
  const authorization = request.headers.get("authorization");
  return (
    authorization !== null &&
    constantTimeEqual(authorization, `Bearer ${getMainInstanceKey()}`)
  );
};

/** One built site's machine-readable upgrade credentials. `siteUrl` is the
 * site's public origin. The update workflow polls the site's read-only page
 * while the update runs. */
type SiteCredentials = {
  dbToken: string;
  dbUrl: string;
  name: string;
  scriptId: string;
  siteUrl: string;
};

const handleSiteCredentials = async (request: Request): Promise<Response> => {
  // Off unless configured — 404 so a non-builder/disabled instance doesn't
  // even reveal that the endpoint exists.
  if (!isInstanceApiEnabled()) return apiErrorResponse("not_found", 404);

  if (!presentsInstanceKey(request)) {
    logError({
      code: ErrorCode.INSTANCE_CREDENTIALS_REFUSED,
      detail: "bearer token missing or wrong",
    });
    return apiErrorResponse("unauthorized", 401);
  }

  // The deploy tier being published. Absent/empty ⇒ release (reaches every
  // site, preserving the pre-tier "whole fleet" behaviour); a junk value is a
  // 400 rather than a silent fall-through that would deploy to the wrong set.
  const deployTier =
    new URL(request.url).searchParams.get("tier") || DEFAULT_UPDATE_TIER;
  if (!isUpdateTier(deployTier)) {
    // The key matched, so the call is accepted. The caller's own tier text
    // stays out of the report, because nothing bounds or escapes it.
    logError({
      code: ErrorCode.INSTANCE_CREDENTIALS_ACCEPTED,
      detail: "unknown tier requested, no sites returned",
    });
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
      siteUrl: site.siteUrl,
    }));

  // The operator learns which tier was served and how many sites it reached.
  // Delivery joins the request's pending work, as every report does: it runs
  // inside the request, and a failed send never fails the answer. The detail
  // carries no token, key, URL, or site name.
  logError({
    code: ErrorCode.INSTANCE_CREDENTIALS_ACCEPTED,
    detail: `tier=${deployTier} sites=${credentials.length}`,
  });

  // Echo the applied tier so a caller can confirm the server actually filtered:
  // a pre-tier build ignores ?tier= and omits this, letting the canary workflow
  // fail closed rather than fan a non-release deploy out to the whole fleet.
  return jsonResponse({ sites: credentials, tier: deployTier });
};

export const instanceRoutes = defineRoutes({
  "POST /instance/site-credentials": handleSiteCredentials,
});
