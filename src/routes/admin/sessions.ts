/**
 * Admin session management routes
 */

import { hashSessionToken } from "#lib/crypto.ts";
import { deleteOtherSessions, getAllSessions } from "#lib/db/sessions.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  getSearchParam,
  htmlResponse,
  redirectWithSuccess,
  requireOwnerOr,
  withOwnerAuthForm,
} from "#routes/utils.ts";
import { adminSessionsPage } from "#templates/admin/sessions.tsx";

/**
 * Handle GET /admin/sessions
 */
const handleAdminSessionsGet = (request: Request): Promise<Response> =>
  requireOwnerOr(request, async (session) => {
    const sessions = await getAllSessions();
    const tokenHash = await hashSessionToken(session.token);
    const success = getSearchParam(request, "success");
    return htmlResponse(
      adminSessionsPage(sessions, tokenHash, session, success ?? undefined),
    );
  });

/**
 * Handle POST /admin/sessions (log out of all other sessions)
 */
const handleAdminSessionsPost = (request: Request): Promise<Response> =>
  withOwnerAuthForm(request, async (session) => {
    await deleteOtherSessions(session.token);
    return redirectWithSuccess("/admin/sessions", "Logged out of all other sessions");
  });

/** Session management routes */
export const sessionsRoutes = defineRoutes({
  "GET /admin/sessions": (request) => handleAdminSessionsGet(request),
  "POST /admin/sessions": (request) => handleAdminSessionsPost(request),
});
