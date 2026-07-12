import { handlersFor } from "#routes/admin/handlers.ts";
/**
 * Admin API key management routes
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { createActionHandler } from "#routes/admin/actions.ts";
import { createConfirmedHandlers } from "#routes/admin/confirmation.ts";
import { type AuthSession, requireOwnerOr } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { htmlResponse, notFoundResponse } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import {
  ADMIN_API_ENDPOINTS,
  PUBLIC_API_ENDPOINTS,
} from "#shared/admin-api-example.ts";
import { unwrapKeyWithToken } from "#shared/crypto/keys.ts";
import { generateSecureToken } from "#shared/crypto/utils.ts";
import {
  createApiKey,
  deleteApiKey,
  getApiKeyForUser,
  getApiKeysForUser,
} from "#shared/db/api-keys.ts";
import { defineForm } from "#shared/forms.tsx";
import type { AdminSession } from "#shared/types.ts";
import {
  adminApiDocsPage,
  adminApiKeyManagePage,
  adminApiKeysPage,
  adminDeleteApiKeyPage,
} from "#templates/admin/api-keys.tsx";
/* jscpd:ignore-end */

export const apiKeyForm = defineForm({
  fields: [
    {
      label: "Name",
      maxlength: 100,
      name: "name",
      placeholder: "e.g. CI Pipeline",
      required: true,
      type: "text" as const,
    },
  ] as const,
  id: "apiKey",
});

/** Owner-guarded handler that loads some data for the session up front, then
 * hands the session and that data to `handle`. */
const withOwnerData =
  <T>(load: (session: AuthSession) => Promise<T>) =>
  (
    request: Request,
    handle: (session: AdminSession, data: T) => Response | Promise<Response>,
  ): Promise<Response> =>
    requireOwnerOr(request, async (session) =>
      handle(session, await load(session)),
    );

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

      if (!session.wrappedDataKey) {
        throw new Error("Session key unavailable");
      }

      // Unwrap the DATA_KEY from the current session
      const dataKey = await unwrapKeyWithToken(
        session.wrappedDataKey,
        session.token,
      );

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
  render: (apiKey, session) => adminDeleteApiKeyPage(apiKey, session),
  successMessage: "API key deleted",
  successRedirect: "/admin/api-keys",
});

/**
 * Handle GET /admin/api-keys/:apiKeyId — per-key management page
 */
const handleApiKeyManageGet: TypedRouteHandler<
  "GET /admin/api-keys/:apiKeyId"
> = (request, { apiKeyId }) =>
  withOwnerApiKeys(request, (session, keys) => {
    const apiKey = keys.find((k) => k.id === apiKeyId);
    if (!apiKey) return notFoundResponse();
    const flash = applyFlash(request);
    return htmlResponse(
      adminApiKeyManagePage(apiKey, session, {
        error: flash.error,
        success: flash.success,
      }),
    );
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

export const adminHandlers = handlersFor("apiKeys")({
  getApiKeys: handleApiKeysGet,
  getApiKeysByApiKeyId: handleApiKeyManageGet,
  getApiKeysByApiKeyIdDelete: (request, { apiKeyId }) =>
    apiKeyDelete.get(request, apiKeyId),
  getApiKeysDocs: handleApiDocsGet,
  postApiKeys: handleApiKeysPost,
  postApiKeysByApiKeyIdDelete: (request, { apiKeyId }) =>
    apiKeyDelete.post(request, apiKeyId),
});
