/**
 * Admin session management routes
 */

import { hashSessionToken } from "#lib/crypto/hashing.ts";
import { deleteOtherSessions, getAllSessions } from "#lib/db/sessions.ts";
import { getFlash } from "#lib/flash-context.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { OWNER_FORM, ownerPage, withAuth } from "#routes/auth.ts";
import { redirect } from "#routes/response.ts";
import { adminSessionsPage } from "#templates/admin/sessions.tsx";

/**
 * Handle GET /admin/sessions
 */
const handleAdminSessionsGet: TypedRouteHandler<"GET /admin/sessions"> =
  ownerPage(async (session) => {
    const sessions = await getAllSessions();
    const tokenHash = await hashSessionToken(session.token);
    const flash = getFlash();
    return adminSessionsPage(sessions, tokenHash, session, flash.success);
  });

/**
 * Handle POST /admin/sessions (log out of all other sessions)
 */
const handleAdminSessionsPost = (request: Request): Promise<Response> =>
  withAuth(request, OWNER_FORM, async (session) => {
    await deleteOtherSessions(session.token);
    return redirect(
      "/admin/sessions",
      "Logged out of all other sessions",
      true,
    );
  });

/** Session management routes */
export const sessionsRoutes = defineRoutes({
  "GET /admin/sessions": handleAdminSessionsGet,
  "POST /admin/sessions": handleAdminSessionsPost,
});
