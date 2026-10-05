/** The /api/admin mount gate. It lives alone so the app router can load it
 * without the resource modules. An unauthenticated request must be refused
 * before any resource copy loads. The resource modules translate form schemas
 * while they evaluate, so they load inside the API's message groups. Role
 * decisions belong to each route's own policy (see the resource modules).
 */

import {
  type AuthPolicy,
  type AuthSession,
  authenticateFor,
} from "#routes/auth.ts";
import { ALL_ADMIN_LEVELS } from "#types";

export const ADMIN_API_MOUNT: AuthPolicy<"json"> = {
  allowApiKey: true,
  body: "json",
  roles: ALL_ADMIN_LEVELS,
};

export const requireAdminApiOr = async (
  request: Request,
  handler: (session: AuthSession) => Response | null | Promise<Response | null>,
): Promise<Response | null> => {
  const auth = await authenticateFor(request, ADMIN_API_MOUNT);
  return auth instanceof Response ? auth : handler(auth.session);
};
