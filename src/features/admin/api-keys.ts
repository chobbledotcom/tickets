import { entityTabRoutes } from "#routes/admin/route-tables.ts";
import { defineRoutes } from "#routes/router.ts";
import { adminPath, adminPattern } from "#shared/admin-surface.ts";
/**
 * Admin API key management routes
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { createActionHandler } from "#routes/admin/actions.ts";
import { createConfirmedHandlers } from "#routes/admin/confirmation.ts";
import {
  defineEntityPage,
  deleteActionTab,
  type EntityPage,
  type TabDef,
} from "#routes/admin/entity-pages.ts";
import { withOwnerData } from "#routes/admin/owner-route.ts";
import { requireOwnerOr } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { htmlResponse } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { PUBLIC_API_ENDPOINTS } from "#shared/admin-api-example/public.ts";
import { ADMIN_API_ENDPOINTS } from "#shared/admin-api-example.ts";
import { unwrapSessionDataKey } from "#shared/crypto/keys.ts";
import { generateSecureToken } from "#shared/crypto/utils.ts";
import {
  createApiKey,
  deleteApiKey,
  getApiKeyForUser,
  getApiKeysForUser,
} from "#shared/db/api-keys.ts";
import {
  type ApiKeyDisplay,
  adminApiDocsPage,
  adminApiKeyDeletePage,
  adminApiKeysPage,
  apiKeySummaryRows,
} from "#templates/admin/api-keys.tsx";

/* jscpd:ignore-end */

/** Owner-guarded handler that loads the caller's API keys up front. */
const withOwnerApiKeys = withOwnerData((session) =>
  getApiKeysForUser(session.userId),
);

/**
 * Handle GET /admin/api-keys
 */
const handleApiKeysGet: TypedRouteHandler<"GET /admin/api-keys"> = (request) =>
  withOwnerApiKeys(request, (session, keys) => {
    const flash = applyFlash(request);
    // The API key is embedded in the flash success message after a newline
    const newLineIdx = flash.success?.indexOf("\n") ?? -1;
    const success =
      newLineIdx >= 0 ? flash.success!.slice(0, newLineIdx) : flash.success;
    const newKey =
      newLineIdx >= 0 ? flash.success!.slice(newLineIdx + 1) : undefined;
    return htmlResponse(
      adminApiKeysPage(keys, session, {
        error: flash.error,
        newKey,
        success,
      }),
    );
  });

/**
 * Handle POST /admin/api-keys (create new API key)
 */
const handleApiKeysPost: TypedRouteHandler<"POST /admin/api-keys"> =
  createActionHandler({
    auth: "owner",
    execute: async (session, form) => {
      const name = form.getString("name");
      if (!name) {
        throw new Error(t("error.name_required"));
      }
      if (name.length > 100) {
        throw new Error("Name must be under 100 characters");
      }

      // Unwrap the DATA_KEY from the current session
      const dataKey = await unwrapSessionDataKey(session);

      const { apiKey } = await createApiKey(
        session.userId,
        name,
        dataKey,
        generateSecureToken,
      );

      (session as Record<string, unknown>).createdApiKey = apiKey;
    },
    message: (session) => {
      const apiKey = (session as Record<string, unknown>)
        .createdApiKey as string;
      return `API key created\n${apiKey}`;
    },
    redactedSecret: (session) =>
      (session as Record<string, unknown>).createdApiKey as string | undefined,
    successRedirect: "/admin/api-keys",
  });

/** Confirmed-delete handlers for API keys */
const apiKeyDelete = createConfirmedHandlers<{ id: number; name: string }>({
  identifier: (apiKey) => apiKey.name,
  identifierLabel: "API key name",
  load: (id, session) => getApiKeyForUser(id, session.userId).catch(() => null),
  onConfirm: async (_apiKey, id, session) => {
    await deleteApiKey(id, session.userId);
  },
  path: "/admin/api-keys/:apiKeyId/delete",
  render: adminApiKeyDeletePage,
  successMessage: "API key deleted",
  successRedirect: "/admin/api-keys",
});

const overviewTab: TabDef<ApiKeyDisplay> = {
  labelKey: "entity.tab.overview",
  sections: [
    {
      kind: "summary",
      rows: (apiKey) => Promise.resolve(apiKeySummaryRows(apiKey)),
    },
  ],
  slug: "",
};

/** The owner-only API key summary and actions page. */
const apiKeyPage: EntityPage<ApiKeyDisplay> = defineEntityPage({
  basePath: (id) => adminPath("apiKey", { apiKeyId: id }),
  guard: requireOwnerOr,
  load: async (id, session) =>
    (await getApiKeysForUser(session.userId)).find((key) => key.id === id) ??
    null,
  navActive: adminPattern("apiKeys"),
  tabs: [
    overviewTab,
    deleteActionTab(
      "api_keys.delete_submit",
      (apiKey) => `/admin/api-keys/${apiKey.id}/delete`,
    ),
  ],
  titleOf: (apiKey) => apiKey.name,
});

/**
 * Handle GET /admin/api-keys/docs — API documentation page
 */
const handleApiDocsGet: TypedRouteHandler<"GET /admin/api-keys/docs"> = (
  request,
) =>
  requireOwnerOr(request, (session) =>
    htmlResponse(
      adminApiDocsPage(session, PUBLIC_API_ENDPOINTS, ADMIN_API_ENDPOINTS),
    ),
  );

export const adminHandlers = defineRoutes({
  ...entityTabRoutes(adminPattern("apiKey"), apiKeyPage),
  "GET /admin/api-keys": handleApiKeysGet,
  "GET /admin/api-keys/:apiKeyId/delete": (request, { apiKeyId }) =>
    apiKeyDelete.get(request, apiKeyId),
  "GET /admin/api-keys/docs": handleApiDocsGet,
  "POST /admin/api-keys": handleApiKeysPost,
  "POST /admin/api-keys/:apiKeyId/delete": (request, { apiKeyId }) =>
    apiKeyDelete.post(request, apiKeyId),
});
