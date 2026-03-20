/**
 * Admin API key management routes
 */

import { generateSecureToken, unwrapKeyWithToken } from "#lib/crypto.ts";
import {
  countApiKeysForUser,
  createApiKey,
  deleteApiKey,
  getApiKeysForUser,
  MAX_KEYS_PER_USER,
} from "#lib/db/api-keys.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import {
  getSearchParam,
  htmlResponse,
  jsonResponse,
  redirect,
  requireOwnerOr,
  withOwnerAuthForm,
} from "#routes/utils.ts";
import { adminApiKeysPage } from "#templates/admin/api-keys.tsx";

/**
 * Handle GET /admin/api-keys
 */
const handleApiKeysGet: TypedRouteHandler<"GET /admin/api-keys"> = (request) =>
  requireOwnerOr(request, async (session) => {
    const keys = await getApiKeysForUser(session.userId);
    const success = getSearchParam(request, "success");
    const error = getSearchParam(request, "error");
    return htmlResponse(adminApiKeysPage(keys, session, { success, error }));
  });

/**
 * Handle POST /admin/api-keys (create new API key)
 */
const handleApiKeysPost = (request: Request): Promise<Response> =>
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

    const count = await countApiKeysForUser(session.userId);
    if (count >= MAX_KEYS_PER_USER) {
      return redirect(
        "/admin/api-keys",
        `Maximum of ${MAX_KEYS_PER_USER} API keys reached`,
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

    // Return the plaintext key in the response (shown once)
    const keys = await getApiKeysForUser(session.userId);
    return htmlResponse(
      adminApiKeysPage(keys, session, {
        success: "API key created",
        newKey: apiKey,
      }),
    );
  });

/**
 * Handle POST /admin/api-keys/:apiKeyId/delete
 */
const handleApiKeyDelete: TypedRouteHandler<
  "POST /admin/api-keys/:apiKeyId/delete"
> = (request, { apiKeyId }) =>
  withOwnerAuthForm(request, async (session) => {
    const deleted = await deleteApiKey(apiKeyId, session.userId);
    if (!deleted) {
      return redirect("/admin/api-keys", "API key not found", false);
    }
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
  "POST /admin/api-keys/:apiKeyId/delete": handleApiKeyDelete,
  "GET /admin/api-keys/docs": handleApiDocsGet,
});
