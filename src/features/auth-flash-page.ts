/** The flash-threading GET page helper. Kept out of auth.ts, which is already
 * over the file-length ceiling. */

import { type AuthSession, authPage, type SessionGuard } from "#routes/auth.ts";
import type { RequestRoute } from "#shared/response-steps.ts";

/** A GET page that reads the flashed error and success and hands them to the
 * page builder. */
export const authFlashPage = (
  requireSession: SessionGuard<AuthSession>,
  render: (
    session: AuthSession,
    error: string | undefined,
    success: string | undefined,
  ) => string,
): RequestRoute =>
  authPage(requireSession)((session, _request, flash) =>
    render(session, flash.error, flash.success),
  );
