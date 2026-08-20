/* jscpd:ignore-start */
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";

/**
 * Admin session management routes
 */

import { hashSessionToken } from "#crypto/hashing.ts";
import { deleteOtherSessions, getAllSessions } from "#db/sessions.ts";
import { gatedPost, OWNER_FORM, ownerPage } from "#routes/auth.ts";
import { redirect } from "#routes/response.ts";
import { adminSessionsPage } from "#templates/admin/sessions.tsx";

/* jscpd:ignore-end */

/**
 * Handle GET /admin/sessions
 */
const handleAdminSessionsGet: TypedRouteHandler<"GET /admin/sessions"> =
  ownerPage(async (session, _request, flash) => {
    const sessions = await getAllSessions();
    const tokenHash = await hashSessionToken(session.token);
    return adminSessionsPage(sessions, tokenHash, session, flash.success);
  });

/**
 * Handle POST /admin/sessions (log out of all other sessions)
 */
const handleAdminSessionsPost = gatedPost(OWNER_FORM)(async (session) => {
  await deleteOtherSessions(session.token);
  return redirect("/admin/sessions", "Logged out of all other sessions", true);
});

/** Session management routes */
export const adminHandlers = defineRoutes({
  "GET /admin/sessions": handleAdminSessionsGet,
  "POST /admin/sessions": handleAdminSessionsPost,
});
