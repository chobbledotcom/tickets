/**
 * Admin builder routes — create new Tickets instances via Bunny API
 * Owner-only access, gated behind CAN_BUILD_SITES=true env var
 */

import { createAuthedFormRoute } from "#lib/app-forms.ts";
import { builderApi } from "#lib/builder.ts";
import { logActivity } from "#lib/db/activityLog.ts";
import { getAllBuiltSites, insertBuiltSite } from "#lib/db/built-sites.ts";
import { settings } from "#lib/db/settings.ts";
import { getEnv } from "#lib/env.ts";
import { defineForm } from "#lib/forms.tsx";
import { OWNER_FORM, requireOwnerOr } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
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
    bunnyUrl: s.bunnyUrl,
    created: new Date(s.created).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }),
    name: s.name,
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

export const builderForm = defineForm({
  fields: [
    {
      label: "Site Name",
      maxlength: 64,
      minlength: 1,
      name: "site_name",
      placeholder: "My Event Site",
      required: true,
      type: "text" as const,
    },
    {
      label: "Database URL",
      name: "db_url",
      placeholder: "libsql://your-db.turso.io",
      required: true,
      type: "url" as const,
    },
    {
      label: "Database Token",
      name: "db_token",
      placeholder: "Token for the database",
      required: true,
      type: "password" as const,
    },
  ] as const,
  id: "builder",
});

const builderPost = createAuthedFormRoute({
  auth: OWNER_FORM,
  form: builderForm,
  onInvalid: ({ error }) => errorRedirect(BUILDER_PATH, error),
  onValid: async ({ form, values }) => {
    const dbTest = await builderApi.testDbConnection(
      values.db_url,
      values.db_token,
    );
    if (!dbTest.ok) {
      return errorRedirect(
        BUILDER_PATH,
        `Database connection failed: ${dbTest.error}`,
      );
    }

    const result = await settings.withCurrentTask("builder", () =>
      builderApi.buildSite({
        dbToken: values.db_token,
        dbUrl: values.db_url,
        siteName: values.site_name,
      }),
    );

    if (!result.ok) return errorRedirect(BUILDER_PATH, result.error);

    const buildResult = result.value;
    if (!buildResult.ok) return errorRedirect(BUILDER_PATH, buildResult.error);

    await insertBuiltSite(
      values.site_name,
      buildResult.defaultHostname,
      values.db_url,
      values.db_token,
      form.getString("assignable") === "1",
      String(buildResult.scriptId),
    );
    await logActivity(`Built new site: ${values.site_name}`);

    return redirect(
      BUILDER_PATH,
      `Site "${values.site_name}" created successfully at ${buildResult.defaultHostname}`,
      true,
    );
  },
});

export const builderRoutes = defineRoutes({
  "GET /admin/builder": handleBuilderGet,
  "POST /admin/builder": (r: Request) =>
    isBuilderEnabled() ? builderPost(r, {}) : notFoundResponse(),
});
