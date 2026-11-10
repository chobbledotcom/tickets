/** The database key option on a built site: the two steps that replace the
 * site's key, and the timer page between them. */

import type { BuiltSite } from "#db/built-sites/types.ts";
import { findBuiltSiteByIdPrimary } from "#db/built-sites.ts";
import { t } from "#i18n";
import { createIdEntityHandler } from "#routes/entity.ts";
import { htmlResponse, redirectResponse } from "#routes/response.ts";
import { pageGuardAt } from "#routes/route-gates.ts";
import { adminRecordPath } from "#shared/admin-surface.ts";
import {
  completeDatabaseKeyRotation,
  databaseKeyIssueUrl,
  databaseKeyLinkStartOrNull,
  startDatabaseKeyRotation,
} from "#shared/database-key-rotation.ts";
import { DatabaseKeyRotationPage } from "#templates/admin/built-sites/database-key.tsx";
import { builtSiteFormPost } from "./built-site-form.ts";
import { answerLoggedTab, refuseTab } from "./built-site-tab.ts";

const ROTATION_PATTERN = "/admin/built-sites/:id/rotate-database-key";

const COMPLETE_ROTATION_PATTERN =
  "/admin/built-sites/:id/rotate-database-key/complete";

/** Step one: remove every old key, record when the pause began, and send the
 * browser to the timer page. */
const handleRotateDatabaseKey = builtSiteFormPost(async (site) => {
  const started = await startDatabaseKeyRotation(site);
  if (!started.ok) return refuseTab("secrets", site.id, started.error);
  return redirectResponse(
    adminRecordPath("builtSiteRotateDatabaseKey", site.id),
  );
});

/** The timer page. The POST redirects here, so a refresh repeats no write, and
 * every render carries the same signed link for the rotation that waits. */
const handleShowDatabaseKeyRotation = createIdEntityHandler<BuiltSite>(
  findBuiltSiteByIdPrimary,
)(pageGuardAt(ROTATION_PATTERN))(async (site, session) => {
  const started = site.databaseKeyRotationStarted;
  if (started === 0) {
    return refuseTab(
      "secrets",
      site.id,
      t("built_sites.database_key_rotation_not_pending"),
    );
  }
  return htmlResponse(
    DatabaseKeyRotationPage({
      finishUrl: await databaseKeyIssueUrl(site.id, started),
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
  const started = await databaseKeyLinkStartOrNull(
    site.id,
    search.get("start"),
    search.get("sig"),
  );
  if (started === null) {
    return refuseTab(
      "secrets",
      site.id,
      t("built_sites.database_key_link_expired"),
    );
  }
  const outcome = await completeDatabaseKeyRotation(site, started);
  return answerLoggedTab("secrets", site.id, outcome, {
    activity: `Rotated database key for '${site.name}'`,
    success: t("built_sites.database_key_rotated"),
  });
});

/** The routes this option serves, named beside their handlers. */
export const databaseKeyRoutes = {
  "GET /admin/built-sites/:id/rotate-database-key":
    handleShowDatabaseKeyRotation,
  "GET /admin/built-sites/:id/rotate-database-key/complete":
    handleCompleteDatabaseKeyRotation,
  "POST /admin/built-sites/:id/rotate-database-key": handleRotateDatabaseKey,
};
