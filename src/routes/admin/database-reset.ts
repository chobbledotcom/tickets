/**
 * Demo reset routes - allows unauthenticated users to reset the database in demo mode.
 * Access is strictly restricted to demo mode (DEMO_MODE=true).
 */

import { isDemoMode } from "#lib/demo.ts";
import { signCsrfToken } from "#lib/csrf.ts";
import { resetDatabase } from "#lib/db/migrations.ts";
import { clearSessionCookie } from "#lib/cookies.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import {
  htmlResponse,
  notFoundResponse,
  redirectResponse,
  withCsrfForm,
} from "#routes/utils.ts";
import {
  demoResetPage,
  RESET_DATABASE_PHRASE,
  RESET_PHRASE_MISMATCH_ERROR,
} from "#templates/admin/database-reset.tsx";

/** Guard: require demo mode, else 404 */
const withDemoResetAccess = (
  handler: () => Response | Promise<Response>,
): Response | Promise<Response> =>
  isDemoMode() ? handler() : notFoundResponse();

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
const handleDemoResetGet = (): Response | Promise<Response> =>
  withDemoResetAccess(async () => {
    await signCsrfToken();
    return htmlResponse(demoResetPage());
  });

/** Handle POST /demo/reset - reset the database */
const handleDemoResetPost = (request: Request): Response | Promise<Response> =>
  withDemoResetAccess(() =>
    withCsrfForm(request, resetPageError, async (form) => {
      const phraseError = validateResetPhrase(form);
      if (phraseError) return resetPageError(phraseError, 400);

      await resetDatabase();
      return redirectResponse("/setup/", clearSessionCookie());
    }),
  );

/** Demo reset routes */
export const demoResetRoutes = defineRoutes({
  "GET /demo/reset": handleDemoResetGet,
  "POST /demo/reset": handleDemoResetPost,
});

export const routeDatabaseReset = createRouter(demoResetRoutes);