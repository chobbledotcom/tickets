import { defineAdminRoutes } from "#routes/admin/route-tables.ts";
import type { TypedRouteHandler } from "#routes/router.ts";

/**
 * Admin session management routes
 */

import { hashSessionToken } from "#crypto/hashing.ts";
import { deleteOtherSessions, getAllSessions } from "#db/sessions.ts";
import { t } from "#i18n";
import { gatedPost } from "#routes/auth.ts";
import { adminRedirect } from "#routes/response.ts";
import { authPageAt, formPolicyAt } from "#routes/route-gates.ts";
import { adminSessionsPage } from "#templates/admin/sessions.tsx";

/**
 * Handle GET /admin/sessions
 */
const handleAdminSessionsGet: TypedRouteHandler<"GET /admin/sessions"> =
  authPageAt("/admin/sessions")(async (session, _request, flash) => {
    const sessions = await getAllSessions();
    const tokenHash = await hashSessionToken(session.token);
    return adminSessionsPage(sessions, tokenHash, session, flash.success);
  });

/**
 * Handle POST /admin/sessions (log out of all other sessions)
 */
const handleAdminSessionsPost = gatedPost(formPolicyAt("/admin/sessions"))(
  async (session) => {
    await deleteOtherSessions(session.token);
    return adminRedirect(
      "sessions",
      {},
      t("success.logged_out_everywhere"),
      true,
    );
  },
);

/** Session management routes */
export const adminHandlers = defineAdminRoutes({
  "GET /admin/sessions": handleAdminSessionsGet,
  "POST /admin/sessions": handleAdminSessionsPost,
});
