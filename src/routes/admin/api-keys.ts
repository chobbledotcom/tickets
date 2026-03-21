/**
 * Admin API key management routes
 */

import { generateSecureToken, unwrapKeyWithToken } from "#lib/crypto.ts";
import {
  createApiKey,
  deleteApiKey,
  getApiKeyForUser,
  getApiKeysForUser,
} from "#lib/db/api-keys.ts";
import { verifyIdentifier } from "#routes/admin/utils.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import {
  getSearchParam,
  htmlResponse,
  jsonResponse,
  orNotFound,
  redirect,
  requireOwnerOr,
  withOwnerAuthForm,
} from "#routes/utils.ts";
import {
  adminApiKeysPage,
  adminDeleteApiKeyPage,
} from "#templates/admin/api-keys.tsx";

/**
 * Handle GET /admin/api-keys
 */
const handleApiKeysGet: TypedRouteHandler<"GET /admin/api-keys"> = (request) =>
  requireOwnerOr(request, async (session) => {
    const keys = await getApiKeysForUser(session.userId);
    const success = getSearchParam(request, "success");
    const error = getSearchParam(request, "error");
    const newKey = getSearchParam(request, "key") || undefined;
    return htmlResponse(
      adminApiKeysPage(keys, session, { success, error, newKey }),
    );
  });

/**
 * Handle POST /admin/api-keys (create new API key)
 */
const handleApiKeysPost: TypedRouteHandler<"POST /admin/api-keys"> = (
  request,
) =>
  withOwnerAuthForm(request, async (session, form) => {
    const name = (form.get("name") ?? "").trim();
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

    // Redirect back with the key in the URL (shown once on the GET page)
    return redirect(
      `/admin/api-keys?key=${encodeURIComponent(apiKey)}`,
      "API key created",
      true,
    );
  });

/**
 * Handle GET /admin/api-keys/:apiKeyId/delete — confirmation page
 */
const handleApiKeyDeleteGet: TypedRouteHandler<
  "GET /admin/api-keys/:apiKeyId/delete"
> = (request, { apiKeyId }) =>
  requireOwnerOr(request, (session) =>
    orNotFound(
      getApiKeyForUser(apiKeyId, session.userId).catch(() => null),
      (apiKey) => htmlResponse(adminDeleteApiKeyPage(apiKey, session)),
    ),
  );

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

    const confirmIdentifier = form.getString("confirm_identifier");
    if (!verifyIdentifier(apiKey.name, confirmIdentifier)) {
      return htmlResponse(
        adminDeleteApiKeyPage(
          apiKey,
          session,
          "API key name does not match. Please type the exact name to confirm deletion.",
        ),
        400,
      );
    }

    await deleteApiKey(apiKeyId, session.userId);
    return redirect("/admin/api-keys", "API key deleted", true);
  });

/**
 * Handle GET /admin/api-keys/docs — simple API docs page
 */
const handleApiDocsGet: TypedRouteHandler<"GET /admin/api-keys/docs"> = (
  request,
) =>
  requireOwnerOr(request, (_session) => {
    return jsonResponse({
      message: "Admin API documentation",
      authentication:
        "Add 'Authorization: Bearer YOUR_API_KEY' header to requests",
      endpoints: {
        "GET /api/admin/events": "List all events",
        "GET /api/admin/events/:id": "Get event details",
        "GET /api/admin/events/:id/attendees": "List attendees for event",
      },
    });
  });

export const apiKeysRoutes = defineRoutes({
  "GET /admin/api-keys": handleApiKeysGet,
  "POST /admin/api-keys": handleApiKeysPost,
  "GET /admin/api-keys/:apiKeyId/delete": handleApiKeyDeleteGet,
  "POST /admin/api-keys/:apiKeyId/delete": handleApiKeyDelete,
  "GET /admin/api-keys/docs": handleApiDocsGet,
});
