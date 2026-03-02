/**
 * Demo reset routes - allows unauthenticated users to reset the database in demo mode.
 * Access is restricted to demo mode (DEMO_MODE=true) or authenticated admin users.
 */

import { isDemoMode } from "#lib/demo.ts";
import { signCsrfToken } from "#lib/csrf.ts";
import { resetDatabase } from "#lib/db/migrations.ts";
import { clearSessionCookie } from "#lib/cookies.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import {
  getAuthenticatedSession,
  htmlResponse,
  notFoundResponse,
  redirect,
  withCsrfForm,
} from "#routes/utils.ts";
import {
  demoResetPage,
  RESET_DATABASE_PHRASE,
  RESET_PHRASE_MISMATCH_ERROR,
} from "#templates/demo-reset.tsx";

/** Guard: require demo mode or authenticated admin, else 404 */
const withDemoResetAccess = async (
  request: Request,
  handler: () => Response | Promise<Response>,
): Promise<Response> => {
  if (isDemoMode()) return handler();
  const session = await getAuthenticatedSession(request);
  return session ? handler() : notFoundResponse();
};

/** Render demo reset page with an error */
const resetPageError = (message: string, status: number): Response =>
  htmlResponse(demoResetPage(message), status);

/**
 * Validate the confirmation phrase from a form submission.
 * Shared with admin settings reset handler.
 */
export const validateResetPhrase = (form: URLSearchParams): string | null => {
  const confirmPhrase = form.get("confirm_phrase") ?? "";
  return confirmPhrase.trim() === RESET_DATABASE_PHRASE
    ? null
    : RESET_PHRASE_MISMATCH_ERROR;
};

/** Handle GET /demo/reset - show reset confirmation page */
const handleDemoResetGet = (request: Request): Promise<Response> =>
  withDemoResetAccess(request, async () => {
    await signCsrfToken();
    return htmlResponse(demoResetPage());
  });

/** Handle POST /demo/reset - reset the database */
const handleDemoResetPost = (request: Request): Promise<Response> =>
  withDemoResetAccess(request, () =>
    withCsrfForm(request, resetPageError, async (form) => {
      const phraseError = validateResetPhrase(form);
      if (phraseError) return resetPageError(phraseError, 400);

      await resetDatabase();
      return redirect("/setup/", clearSessionCookie());
    }),
  );

/** Demo reset routes */
export const demoResetRoutes = defineRoutes({
  "GET /demo/reset": handleDemoResetGet,
  "POST /demo/reset": handleDemoResetPost,
});

export const routeDemoReset = createRouter(demoResetRoutes);
