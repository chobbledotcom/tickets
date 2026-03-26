/**
 * Admin API key management routes
 */

import {
  ADMIN_API_ENDPOINTS,
  PUBLIC_API_ENDPOINTS,
} from "#lib/admin-api-example.ts";
import { generateSecureToken, unwrapKeyWithToken } from "#lib/crypto.ts";
import {
  createApiKey,
  deleteApiKey,
  getApiKeyForUser,
  getApiKeysForUser,
} from "#lib/db/api-keys.ts";
import { verifyOrRedirect } from "#routes/admin/utils.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import {
  applyFlash,
  htmlResponse,
  orNotFound,
  redirect,
  requireOwnerOr,
  withOwnerAuthForm,
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
        success,
        error: flash.error,
        newKey,
      }),
    );
  });

/**
 * Handle POST /admin/api-keys (create new API key)
 */
const handleApiKeysPost: TypedRouteHandler<"POST /admin/api-keys"> = (
  request,
) =>
  withOwnerAuthForm(request, async (session, form) => {
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

/**
 * Handle GET /admin/api-keys/:apiKeyId/delete — confirmation page
 */
const handleApiKeyDeleteGet: TypedRouteHandler<
  "GET /admin/api-keys/:apiKeyId/delete"
> = (request, { apiKeyId }) =>
  requireOwnerOr(request, (session) => {
    applyFlash(request);
    return orNotFound(
      getApiKeyForUser(apiKeyId, session.userId).catch(() => null),
      (apiKey) => htmlResponse(adminDeleteApiKeyPage(apiKey, session)),
    );
  });

/**
 * Handle POST /admin/api-keys/:apiKeyId/delete
 */
const handleApiKeyDelete: TypedRouteHandler<
  "POST /admin/api-keys/:apiKeyId/delete"
> = (request, { apiKeyId }) =>
  withOwnerAuthForm(request, async (session, form) => {
    let apiKey;
    try {
      apiKey = await getApiKeyForUser(apiKeyId, session.userId);
    } catch {
      return redirect("/admin/api-keys", "API key not found", false);
    }

    const error = verifyOrRedirect(
      form,
      apiKey.name,
      `/admin/api-keys/${apiKeyId}/delete`,
      "API key name",
      "deletion",
    );
    if (error) return error;

    await deleteApiKey(apiKeyId, session.userId);
    return redirect("/admin/api-keys", "API key deleted", true);
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

export const apiKeysRoutes = defineRoutes({
  "GET /admin/api-keys": handleApiKeysGet,
  "POST /admin/api-keys": handleApiKeysPost,
  "GET /admin/api-keys/:apiKeyId/delete": handleApiKeyDeleteGet,
  "POST /admin/api-keys/:apiKeyId/delete": handleApiKeyDelete,
  "GET /admin/api-keys/docs": handleApiDocsGet,
});
