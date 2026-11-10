/** The database key option on a built site: the two steps that replace the
 * site's key, and the timer page between them. */

import { logActivity } from "#db/activity-log.ts";
import type { BuiltSite } from "#db/built-sites/types.ts";
import { findBuiltSiteByIdPrimary } from "#db/built-sites.ts";
import { t } from "#i18n";
import { createIdEntityHandler } from "#routes/entity.ts";
import { htmlResponse } from "#routes/response.ts";
import { pageGuardAt } from "#routes/route-gates.ts";
import {
  databaseKeyIssueAllowed,
  databaseKeyIssueUrl,
  invalidateDatabaseKey,
  issueDatabaseKey,
} from "#shared/database-key-rotation.ts";
import { DatabaseKeyRotationPage } from "#templates/admin/built-sites/database-key.tsx";
import { builtSiteFormPost } from "./built-site-form.ts";
import { answerTab, refuseTab } from "./built-site-tab.ts";

const COMPLETE_ROTATION_PATTERN =
  "/admin/built-sites/:id/rotate-database-key/complete";

/** Step one: remove every old key, then answer the page whose timer ends the
 * provider's short downtime. */
const handleRotateDatabaseKey = builtSiteFormPost(async (site, session) => {
  const outcome = await invalidateDatabaseKey(site);
  if (!outcome.ok) return refuseTab("secrets", site.id, outcome.error);
  return htmlResponse(
    DatabaseKeyRotationPage({
      finishUrl: await databaseKeyIssueUrl(site.id),
      session,
      site,
    }),
  );
});

/** Step two: the timer page's meta refresh opens the signed link. It makes the
 * new key, stores it, sends it to the site, and lands back on the Secrets tab. */
const handleCompleteDatabaseKeyRotation = createIdEntityHandler<BuiltSite>(
  findBuiltSiteByIdPrimary,
)(pageGuardAt(COMPLETE_ROTATION_PATTERN))(async (site, _session, request) => {
  const search = new URL(request.url).searchParams;
  const allowed = await databaseKeyIssueAllowed(
    site.id,
    search.get("exp"),
    search.get("sig"),
  );
  if (!allowed) {
    return refuseTab(
      "secrets",
      site.id,
      t("built_sites.database_key_link_expired"),
    );
  }
  const outcome = await issueDatabaseKey(site);
  if (outcome.ok) {
    await logActivity(`Rotated database key for '${site.name}'`);
  }
  return answerTab(
    "secrets",
    site.id,
    outcome,
    t("built_sites.database_key_rotated"),
  );
});

/** The two routes this option writes through, named beside their handlers. */
export const databaseKeyRoutes = {
  "GET /admin/built-sites/:id/rotate-database-key/complete":
    handleCompleteDatabaseKeyRotation,
  "POST /admin/built-sites/:id/rotate-database-key": handleRotateDatabaseKey,
};
