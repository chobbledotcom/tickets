import { defineRoutes } from "#routes/router.ts";
/**
 * Admin builder routes — create new Tickets instances via Bunny API
 * Owner-only access, gated behind CAN_BUILD_SITES=true env var
 */

/* jscpd:ignore-start */
import { OWNER_FORM, requireOwnerOr } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
/* jscpd:ignore-end */
import { createAuthedFormRoute } from "#shared/app-forms.ts";
import { builderApi } from "#shared/builder.ts";
import {
  isBuilderEnabled,
  isBunnyDbEnabled,
  isDenoDeployEnabled,
  isTursoEnabled,
} from "#shared/config.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { providerOrBunny } from "#shared/db/built-sites/types.ts";
import {
  builtSites,
  builtSitesCrudTable,
  insertBuiltSite,
} from "#shared/db/built-sites.ts";
import { settings } from "#shared/db/settings.ts";
import { defineForm } from "#shared/forms/definition.ts";
import {
  adminBuilderPage,
  type BuiltSiteDisplay,
} from "#templates/admin/builder.tsx";

const BUILDER_PATH = "/admin/builder";

/** Convert built sites to display format */
const toDisplay = (
  sites: Awaited<ReturnType<typeof builtSites.getAll>>,
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
    const sites = toDisplay(await builtSites.getAll());
    return htmlResponse(adminBuilderPage(session, sites, error, success));
  });
};

export const builderForm = defineForm({
  fields: [
    {
      label: "Site name",
      maxlength: 64,
      minlength: 1,
      name: "site_name",
      placeholder: "My Listing Site",
      required: true,
      type: "text" as const,
    },
    {
      label: "Hosting provider",
      name: "hosting_provider",
      options: [
        { label: "Bunny Edge Scripting", value: "bunny" },
        { label: "Deno Deploy", value: "deno" },
      ] as const,
      type: "select" as const,
    },
    {
      label: "Database provider",
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
      label: "Database token",
      name: "db_token",
      placeholder: "Token for the database",
      type: "password" as const,
    },
  ] as const,
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
        values.db_token,
      );
      if (!dbTest.ok) {
        return errorRedirect(
          BUILDER_PATH,
          `Database connection failed: ${dbTest.error}`,
        );
      }
    }

    const hostingProvider = providerOrBunny(values.hosting_provider, "deno");

    if (hostingProvider === "deno" && !isDenoDeployEnabled()) {
      return errorRedirect(BUILDER_PATH, "Deno Deploy is not configured");
    }

    const dbProviderVal = values.db_provider;
    const dbProvider = providerOrBunny(dbProviderVal, "turso");

    const dbError = dbProviderConfigError(dbProviderVal, values.db_url);
    if (dbError) return errorRedirect(BUILDER_PATH, dbError);

    let retainedSiteId: number | null = null;
    const assignable = form.getFlag("assignable");
    const result = await settings.withCurrentTask("builder", () =>
      builderApi.buildSite(
        {
          ...(dbProviderVal === "manual" ? {} : { dbProvider }),
          dbToken: values.db_token,
          dbUrl: values.db_url,
          hostingProvider,
          siteName: values.site_name,
        },
        async (prepared) => {
          const row = await insertBuiltSite(
            values.site_name,
            prepared.defaultHostname,
            prepared.dbUrl,
            prepared.dbToken,
            false,
            prepared.hostingId,
            undefined,
            prepared.hostingProvider,
            prepared.dbProvider,
            prepared.scheduledTaskKey,
          );
          retainedSiteId = row.id;
        },
      ),
    );

    if (!result.ok) return errorRedirect(BUILDER_PATH, result.error);

    const buildResult = result.value;
    if (!buildResult.ok) return errorRedirect(BUILDER_PATH, buildResult.error);

    if (retainedSiteId === null) {
      throw new Error("Built site was published before it was retained");
    }
    if (assignable) {
      await builtSitesCrudTable.update(retainedSiteId, { assignable: true });
    }
    await logActivity(`Built new site: ${values.site_name}`);

    return redirect(
      BUILDER_PATH,
      `Site "${values.site_name}" created successfully at ${buildResult.defaultHostname}`,
      true,
    );
  },
});

export const adminHandlers = defineRoutes({
  "GET /admin/builder": handleBuilderGet,
  "POST /admin/builder": (r: Request) =>
    isBuilderEnabled() ? builderPost(r, {}) : notFoundResponse(),
});
