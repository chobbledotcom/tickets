/**
 * Demo reset routes - allows unauthenticated users to reset the database in demo mode.
 * Access is strictly restricted to demo mode (DEMO_MODE=true).
 */

import { applyFlash } from "#routes/csrf.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
/* jscpd:ignore-start */
import { createFormRoute } from "#shared/app-forms.ts";
import { clearSessionCookie } from "#shared/cookies.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { getAllEvents } from "#shared/db/events.ts";
import { resetDatabase } from "#shared/db/migrations.ts";
import { isDemoMode } from "#shared/demo.ts";
import { defineForm } from "#shared/forms.tsx";
import {
  deleteAllEventStorageFiles,
  isStorageEnabled,
} from "#shared/storage.ts";
import {
  demoResetPage,
  RESET_DATABASE_PHRASE,
  RESET_PHRASE_MISMATCH_ERROR,
} from "#templates/admin/database-reset.tsx";

/* jscpd:ignore-end */

/** Guard: require demo mode, else 404 */
const withDemoResetAccess = (
  handler: () => Response | Promise<Response>,
): Response | Promise<Response> =>
  isDemoMode() ? handler() : notFoundResponse();

/** Form schema for database reset confirmation */
export const demoResetForm = defineForm({
  fields: [
    {
      autocomplete: "off" as const,
      label: "Confirmation phrase",
      name: "confirm_phrase",
      type: "text" as const,
    },
  ] as const,
  id: "demoReset",
  validate: (values) =>
    (values.confirm_phrase ?? "") !== RESET_DATABASE_PHRASE
      ? RESET_PHRASE_MISMATCH_ERROR
      : null,
});

/** Handle GET /demo/reset - show reset confirmation page */
const handleDemoResetGet = (request: Request): Response | Promise<Response> =>
  withDemoResetAccess(async () => {
    applyFlash(request);
    await signCsrfToken();
    return htmlResponse(demoResetPage());
  });

const resetRoute = createFormRoute({
  form: demoResetForm,
  onInvalid: ({ error }) => errorRedirect("/demo/reset", error),
  onValid: async () => {
    if (isStorageEnabled()) {
      await deleteAllEventStorageFiles(await getAllEvents());
    }
    await resetDatabase();
    return redirect("/setup/", "Database reset", true, {
      cookie: clearSessionCookie(),
    });
  },
});

/** Handle POST /demo/reset - reset the database */
const handleDemoResetPost = (request: Request): Response | Promise<Response> =>
  withDemoResetAccess(() => resetRoute(request, {}));

/** Demo reset routes */
export const demoResetRoutes = defineRoutes({
  "GET /demo/reset": handleDemoResetGet,
  "POST /demo/reset": handleDemoResetPost,
});

export const routeDatabaseReset = createRouter(demoResetRoutes);
