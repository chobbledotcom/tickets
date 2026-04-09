/**
 * Admin builder routes — create new Tickets instances via Bunny API
 * Owner-only access, gated behind CAN_BUILD_SITES=true env var
 */

import { builderApi } from "#lib/builder.ts";
import { logActivity } from "#lib/db/activityLog.ts";
import { getAllBuiltSites, insertBuiltSite } from "#lib/db/built-sites.ts";
import { settings } from "#lib/db/settings.ts";
import { getEnv } from "#lib/env.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  applyFlash,
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  OWNER_FORM,
  redirect,
  requireOwnerOr,
  withAuth,
} from "#routes/utils.ts";
import {
  adminBuilderPage,
  type BuiltSiteDisplay,
} from "#templates/admin/builder.tsx";

const BUILDER_PATH = "/admin/builder";

/** Check if the builder feature is enabled */
export const isBuilderEnabled = (): boolean =>
  getEnv("CAN_BUILD_SITES") === "true";

/** Convert built sites to display format */
const toDisplay = (
  sites: Awaited<ReturnType<typeof getAllBuiltSites>>,
): BuiltSiteDisplay[] =>
  sites.map((s) => ({
    name: s.name,
    bunnyUrl: s.bunnyUrl,
    created: new Date(s.created).toLocaleDateString("en-GB", {
      year: "numeric",
      month: "short",
      day: "numeric",
    }),
  }));

/** GET /admin/builder — show builder form and built sites list */
const handleBuilderGet = (request: Request): Promise<Response> => {
  if (!isBuilderEnabled()) return Promise.resolve(notFoundResponse());

  return requireOwnerOr(request, async (session) => {
    const { error, success } = applyFlash(request);
    const sites = toDisplay(await getAllBuiltSites());
    return htmlResponse(adminBuilderPage(session, sites, error, success));
  });
};

/** POST /admin/builder — create a new site */
const handleBuilderPost = async (
  _session: unknown,
  form: import("#lib/form-data.ts").FormParams,
): Promise<Response> => {
  if (!isBuilderEnabled()) return notFoundResponse();

  const siteName = form.getString("site_name");
  const dbUrl = form.getString("db_url");
  const dbToken = form.getString("db_token");

  if (!siteName) return errorRedirect(BUILDER_PATH, "Site name is required");
  if (!dbUrl) return errorRedirect(BUILDER_PATH, "Database URL is required");
  if (!dbToken) {
    return errorRedirect(BUILDER_PATH, "Database token is required");
  }

  // Test database connection first
  const dbTest = await builderApi.testDbConnection(dbUrl, dbToken);
  if (!dbTest.ok) {
    return errorRedirect(
      BUILDER_PATH,
      `Database connection failed: ${dbTest.error}`,
    );
  }

  // Build the site
  const result = await settings.withCurrentTask("builder", () =>
    builderApi.buildSite({ siteName, dbUrl, dbToken }),
  );

  if (!result.ok) {
    return errorRedirect(BUILDER_PATH, result.error);
  }

  const buildResult = result.value;
  if (!buildResult.ok) {
    return errorRedirect(BUILDER_PATH, buildResult.error);
  }

  // Record the built site (including db credentials for future reference)
  await insertBuiltSite(siteName, buildResult.defaultHostname, dbUrl, dbToken);
  await logActivity(`Built new site: ${siteName}`);

  return redirect(
    BUILDER_PATH,
    `Site "${siteName}" created successfully at ${buildResult.defaultHostname}`,
    true,
  );
};

export const builderRoutes = defineRoutes({
  "GET /admin/builder": handleBuilderGet,
  "POST /admin/builder": (r: Request) =>
    withAuth(r, OWNER_FORM, handleBuilderPost),
});
