import {
  defineAdminRoutes,
  entityTabRoutes,
} from "#routes/admin/route-tables.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { adminDestinationAt, adminPattern } from "#shared/admin-surface.ts";
/**
 * Admin API key management routes
 */

import { t } from "#i18n";
import { createActionHandler } from "#routes/admin/actions.ts";
import {
  confirmedDeleteRoutes,
  createConfirmedHandlers,
} from "#routes/admin/confirmation.ts";
import {
  defineEntityPage,
  deleteActionTab,
  type EntityPage,
  overviewTab,
  summarySection,
} from "#routes/admin/entity-pages.ts";
import { pageGuardFor } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { htmlResponse } from "#routes/response.ts";
import { PUBLIC_API_ENDPOINTS } from "#shared/admin-api-example/public.ts";
import { ADMIN_API_ENDPOINTS } from "#shared/admin-api-example.ts";
import { type ApiKeyDisplay, apiKeyRecord } from "#shared/records/api-keys.ts";
import { recordPages } from "#shared/rest/record-pages.ts";
import { asRequestRoute } from "#shared/rest/route-adapters.ts";
import {
  adminApiDocsPage,
  adminApiKeyDeletePage,
  adminApiKeysPage,
  apiKeySummaryRows,
} from "#templates/admin/api-keys.tsx";

/**
 * Handle GET /admin/api-keys
 */
const handleApiKeysGet: TypedRouteHandler<"GET /admin/api-keys"> = (request) =>
  pageGuardFor(adminDestinationAt("/admin/api-keys"))(
    request,
    async (session) => {
      const flash = applyFlash(request);
      // The API key is embedded in the flash success message after a newline
      const newLineIdx = flash.success?.indexOf("\n") ?? -1;
      const success =
        newLineIdx >= 0 ? flash.success!.slice(0, newLineIdx) : flash.success;
      const newKey =
        newLineIdx >= 0 ? flash.success!.slice(newLineIdx + 1) : undefined;
      return htmlResponse(
        adminApiKeysPage(await apiKeyRecord.getAll({ session }), session, {
          error: flash.error,
          newKey,
          success,
        }),
      );
    },
  );

/**
 * Handle POST /admin/api-keys (create new API key)
 */
const handleApiKeysPost: TypedRouteHandler<"POST /admin/api-keys"> =
  createActionHandler({
    execute: async (session, form) => {
      const verdict = await apiKeyRecord.create(
        { name: form.getString("name") },
        undefined,
        { session },
      );
      if (verdict.kind === "refused") throw new Error(verdict.message);
      if (verdict.kind !== "written") {
        throw new Error("The API key was not stored");
      }
      if (verdict.row.secret === undefined) {
        throw new Error("The API key create returned no secret");
      }
      (session as Record<string, unknown>).createdApiKey = verdict.row.secret;
    },
    message: (session) => {
      const apiKey = (session as Record<string, unknown>)
        .createdApiKey as string;
      return `API key created\n${apiKey}`;
    },
    pattern: "/admin/api-keys",
    redactedSecret: (session) =>
      (session as Record<string, unknown>).createdApiKey as string | undefined,
    successRedirect: "/admin/api-keys",
  });

/** Confirmed-delete handlers for API keys */
const apiKeyDelete = createConfirmedHandlers<ApiKeyDisplay>({
  identifier: apiKeyRecord.nameOf,
  identifierLabel: t("api_keys.name_label"),
  load: (id, session) => apiKeyRecord.load(id, { session }),
  onConfirm: async (_key, id, session) => {
    await apiKeyRecord.remove(id, undefined, { session });
  },
  path: "/admin/api-keys/:apiKeyId/delete",
  render: adminApiKeyDeletePage,
  successMessage: "API key deleted",
  successRedirect: "/admin/api-keys",
});

/** The owner-only API key summary and actions page. */
const apiKeyPage: EntityPage<ApiKeyDisplay> = defineEntityPage({
  destination: "apiKey",
  load: async (id, session) =>
    (await apiKeyRecord.getAll({ session })).find((key) => key.id === id) ??
    null,
  navActive: adminPattern("apiKeys"),
  recordId: (apiKey) => apiKey.id,
  tabs: [
    overviewTab([
      summarySection((apiKey) => Promise.resolve(apiKeySummaryRows(apiKey))),
    ]),
    deleteActionTab("api_keys.delete_submit", "apiKeyDelete"),
  ],
  titleOf: (apiKey) => apiKey.name,
});

/**
 * Handle GET /admin/api-keys/docs — API documentation page
 */
const handleApiDocsGet: TypedRouteHandler<"GET /admin/api-keys/docs"> = (
  request,
) =>
  pageGuardFor(adminDestinationAt("/admin/api-keys/docs"))(request, (session) =>
    htmlResponse(
      adminApiDocsPage(session, PUBLIC_API_ENDPOINTS, ADMIN_API_ENDPOINTS),
    ),
  );

/** The API key page routes, bound from the API key record's declaration. */
const pages = recordPages(apiKeyRecord, {
  overrides: {
    createPost: asRequestRoute(handleApiKeysPost),
    ...confirmedDeleteRoutes(apiKeyDelete),
    listGet: asRequestRoute(handleApiKeysGet),
  },
  renderDelete: adminApiKeyDeletePage,
  routes: { delete: "apiKeyDelete" },
  skip: ["new", "edit"],
});

export const adminHandlers = defineAdminRoutes({
  ...entityTabRoutes(adminPattern("apiKey"), apiKeyPage),
  "GET /admin/api-keys": pages.listGet,
  "GET /admin/api-keys/:apiKeyId/delete": (request, { apiKeyId }) =>
    pages.deleteGet(request, { id: apiKeyId }),
  "GET /admin/api-keys/docs": handleApiDocsGet,
  "POST /admin/api-keys": pages.createPost,
  "POST /admin/api-keys/:apiKeyId/delete": (request, { apiKeyId }) =>
    pages.deletePost(request, { id: apiKeyId }),
});
