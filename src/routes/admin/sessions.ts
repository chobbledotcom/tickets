/**
 * Admin session management routes
 */

import { hashSessionToken } from "#lib/crypto.ts";
import { deleteOtherSessions, getAllSessions } from "#lib/db/sessions.ts";
import { defineRoutes } from "#routes/router.ts";
import { htmlResponse, requireOwnerOr, withOwnerAuthForm } from "#routes/utils.ts";
import { adminSessionsPage } from "#templates/admin/sessions.tsx";

/**
 * Handle GET /admin/sessions
 */
const handleAdminSessionsGet = (request: Request): Promise<Response> =>
  requireOwnerOr(request, async (session) => {
    const sessions = await getAllSessions();
    // Hash the token for comparison with stored hashed tokens
    const tokenHash = await hashSessionToken(session.token);
    return htmlResponse(
      adminSessionsPage(sessions, tokenHash, session.csrfToken, session.adminLevel),
    );
  });

/**
 * Handle POST /admin/sessions (log out of all other sessions)
 */
const handleAdminSessionsPost = (request: Request): Promise<Response> =>
  withOwnerAuthForm(request, async (session) => {
    await deleteOtherSessions(session.token);
    const sessions = await getAllSessions();
    // Hash the token for comparison with stored hashed tokens
    const tokenHash = await hashSessionToken(session.token);
    return htmlResponse(
      adminSessionsPage(
        sessions,
        tokenHash,
        session.csrfToken,
        session.adminLevel,
        "Logged out of all other sessions",
      ),
    );
  });

/** Session management routes */
export const sessionsRoutes = defineRoutes({
  "GET /admin/sessions": (request) => handleAdminSessionsGet(request),
  "POST /admin/sessions": (request) => handleAdminSessionsPost(request),
});
