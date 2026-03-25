/**
 * Demo reset routes - allows unauthenticated users to reset the database in demo mode.
 * Access is strictly restricted to demo mode (DEMO_MODE=true).
 */

import { clearSessionCookie } from "#lib/cookies.ts";
import { signCsrfToken } from "#lib/csrf.ts";
import { getAllEvents } from "#lib/db/events.ts";
import { resetDatabase } from "#lib/db/migrations.ts";
import { isDemoMode } from "#lib/demo.ts";
import type { FormParams } from "#lib/form-data.ts";
import { deleteAllEventStorageFiles, isStorageEnabled } from "#lib/storage.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import {
  applyFlash,
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirect,
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

/** Redirect back to demo reset page with an error */
const resetPageError = (message: string, _status: number): Response =>
  errorRedirect("/demo/reset", message);

/**
 * Validate the confirmation phrase from a form submission.
 * Shared with admin settings reset handler.
 */
export const validateResetPhrase = (form: FormParams): string | null => {
  const confirmPhrase = form.getString("confirm_phrase");
  return confirmPhrase === RESET_DATABASE_PHRASE
    ? null
    : RESET_PHRASE_MISMATCH_ERROR;
};

/** Handle GET /demo/reset - show reset confirmation page */
const handleDemoResetGet = (request: Request): Response | Promise<Response> =>
  withDemoResetAccess(async () => {
    applyFlash(request);
    await signCsrfToken();
    return htmlResponse(demoResetPage());
  });

/** Handle POST /demo/reset - reset the database */
const handleDemoResetPost = (request: Request): Response | Promise<Response> =>
  withDemoResetAccess(() =>
    withCsrfForm(request, resetPageError, async (form) => {
      const phraseError = validateResetPhrase(form);
      if (phraseError) return resetPageError(phraseError, 400);

      if (isStorageEnabled()) {
        await deleteAllEventStorageFiles(await getAllEvents());
      }
      await resetDatabase();
      return redirect("/setup/", "Database reset", true, {
        cookie: clearSessionCookie(),
      });
    }),
  );

/** Demo reset routes */
export const demoResetRoutes = defineRoutes({
  "GET /demo/reset": handleDemoResetGet,
  "POST /demo/reset": handleDemoResetPost,
});

export const routeDatabaseReset = createRouter(demoResetRoutes);
