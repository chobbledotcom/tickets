/**
 * Admin builder routes — create new Tickets instances via Bunny API
 * Owner-only access, gated behind CAN_BUILD_SITES=true env var
 */

import { OWNER_FORM, requireOwnerOr } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { createAuthedFormRoute } from "#shared/app-forms.ts";
import { builderApi } from "#shared/builder.ts";
import {
  isBunnyDbEnabled,
  isDenoDeployEnabled,
  isTursoEnabled,
} from "#shared/config.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { getAllBuiltSites, insertBuiltSite } from "#shared/db/built-sites.ts";
import { settings } from "#shared/db/settings.ts";
import { getEnv } from "#shared/env.ts";
import { defineForm } from "#shared/forms.tsx";
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
    created: new Date(s.created).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }),
    name: s.name,
    siteUrl: s.siteUrl,
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
      placeholder: "My Listing Site",
      required: true,
      type: "text" as const,
    },
    {
      label: "Hosting Provider",
      name: "hosting_provider",
      options: [
        { label: "Bunny Edge Scripting", value: "bunny" },
        { label: "Deno Deploy", value: "deno" },
      ] as const,
      type: "select" as const,
    },
    {
      label: "Database Provider",
      name: "db_provider",
      options: [
        { label: "Bunny DB (auto-provision)", value: "bunny" },
        { label: "Turso (auto-provision)", value: "turso" },
        { label: "Manual (enter URL below)", value: "manual" },
      ] as const,
      type: "select" as const,
    },
    {
      hint: "Leave blank to auto-provision a database",
      label: "Database URL",
      name: "db_url",
      placeholder: "libsql://your-db.turso.io",
      type: "url" as const,
    },
    {
      hint: "Leave blank to auto-provision a database",
      label: "Database Token",
      name: "db_token",
      placeholder: "Token for the database",
      type: "password" as const,
    },
  ] as const,
  id: "builder",
});

/** Return an error message when a DB provider isn't configured, else null. */
const dbProviderConfigError = (
  providerVal: string | null | undefined,
  dbUrl: string | null | undefined,
): string | null => {
  if (providerVal === "bunny" && !isBunnyDbEnabled())
    return "Bunny database is not configured";
  if (providerVal === "turso" && !isTursoEnabled())
    return "Turso is not configured";
  if (providerVal === "manual" && !dbUrl)
    return "Database URL is required when using manual provider";
  return null;
};

const builderPost = createAuthedFormRoute({
  auth: OWNER_FORM,
  form: builderForm,
  onInvalid: ({ error }) => errorRedirect(BUILDER_PATH, error),
  onValid: async ({ form, values }) => {
    if (values.db_url) {
      const dbTest = await builderApi.testDbConnection(
        values.db_url,
        values.db_token ?? "",
      );
      if (!dbTest.ok) {
        return errorRedirect(
          BUILDER_PATH,
          `Database connection failed: ${dbTest.error}`,
        );
      }
    }

    const hostingProvider =
      values.hosting_provider === "deno"
        ? ("deno" as const)
        : ("bunny" as const);

    if (hostingProvider === "deno" && !isDenoDeployEnabled()) {
      return errorRedirect(BUILDER_PATH, "Deno Deploy is not configured");
    }

    const dbProviderVal = values.db_provider;
    const dbProvider =
      dbProviderVal === "turso" ? ("turso" as const) : ("bunny" as const);

    const dbError = dbProviderConfigError(dbProviderVal, values.db_url);
    if (dbError) return errorRedirect(BUILDER_PATH, dbError);

    const result = await settings.withCurrentTask("builder", () =>
      builderApi.buildSite({
        ...(dbProviderVal === "manual" ? {} : { dbProvider }),
        ...(values.db_token != null ? { dbToken: values.db_token } : {}),
        ...(values.db_url != null ? { dbUrl: values.db_url } : {}),
        hostingProvider,
        siteName: values.site_name,
      }),
    );

    if (!result.ok) return errorRedirect(BUILDER_PATH, result.error);

    const buildResult = result.value;
    if (!buildResult.ok) return errorRedirect(BUILDER_PATH, buildResult.error);

    await insertBuiltSite(
      values.site_name,
      buildResult.defaultHostname,
      buildResult.dbUrl,
      buildResult.dbToken,
      form.getString("assignable") === "1",
      buildResult.hostingId,
      undefined,
      buildResult.hostingProvider,
      buildResult.dbProvider,
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
