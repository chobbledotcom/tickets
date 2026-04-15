/**
 * Admin API key management routes
 */

import {
  ADMIN_API_ENDPOINTS,
  PUBLIC_API_ENDPOINTS,
} from "#lib/admin-api-example.ts";
import { unwrapKeyWithToken } from "#lib/crypto/keys.ts";
import { generateSecureToken } from "#lib/crypto/utils.ts";
import {
  createApiKey,
  deleteApiKey,
  getApiKeyForUser,
  getApiKeysForUser,
} from "#lib/db/api-keys.ts";
import { createConfirmedHandlers } from "#routes/admin/utils.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import {
  applyFlash,
  htmlResponse,
  OWNER_FORM,
  redirect,
  requireOwnerOr,
  withAuth,
} from "#routes/utils.ts";
import {
  adminApiDocsPage,
  adminApiKeysPage,
  adminDeleteApiKeyPage,
} from "#templates/admin/api-keys.tsx";

/**
 * Handle GET /admin/api-keys
 */
const handleApiKeysGet: TypedRouteHandler<"GET /admin/api-keys"> = (request) =>
  requireOwnerOr(request, async (session) => {
    const keys = await getApiKeysForUser(session.userId);
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
const handleApiKeysPost: TypedRouteHandler<"POST /admin/api-keys"> = (
  request,
) =>
  withAuth(request, OWNER_FORM, async (session, form) => {
    const name = form.getString("name");
    if (!name) {
      return redirect("/admin/api-keys", "Name is required", false);
    }
    if (name.length > 100) {
      return redirect(
        "/admin/api-keys",
        "Name must be under 100 characters",
        false,
      );
    }

    if (!session.wrappedDataKey) {
      return redirect("/admin/api-keys", "Session key unavailable", false);
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

    // Embed the key in the flash message (after a newline) so it's not exposed in the URL
    return redirect("/admin/api-keys", `API key created\n${apiKey}`, true);
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

export const apiKeysRoutes = {
  ...apiKeyDelete.routes,
  ...defineRoutes({
    "GET /admin/api-keys": handleApiKeysGet,
    "GET /admin/api-keys/docs": handleApiDocsGet,
    "POST /admin/api-keys": handleApiKeysPost,
  }),
};
