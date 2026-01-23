/**
 * Admin session management routes
 */

import { deleteOtherSessions, getAllSessions } from "#lib/db";
import { adminSessionsPage } from "#templates";
import { defineRoutes } from "../router.ts";
import { htmlResponse, requireSessionOr, withAuthForm } from "../utils.ts";

/**
 * Handle GET /admin/sessions
 */
const handleAdminSessionsGet = (request: Request): Promise<Response> =>
  requireSessionOr(request, async (session) => {
    const sessions = await getAllSessions();
    return htmlResponse(
      adminSessionsPage(sessions, session.token, session.csrfToken),
    );
  });

/**
 * Handle POST /admin/sessions (log out of all other sessions)
 */
const handleAdminSessionsPost = (request: Request): Promise<Response> =>
  withAuthForm(request, async (session) => {
    await deleteOtherSessions(session.token);
    const sessions = await getAllSessions();
    return htmlResponse(
      adminSessionsPage(
        sessions,
        session.token,
        session.csrfToken,
        "Logged out of all other sessions",
      ),
    );
  });

/** Session management routes */
export const sessionsRoutes = defineRoutes({
  "GET /admin/sessions": (request) => handleAdminSessionsGet(request),
  "POST /admin/sessions": (request) => handleAdminSessionsPost(request),
});
