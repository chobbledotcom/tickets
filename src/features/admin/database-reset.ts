/**
 * Demo reset routes - allows unauthenticated users to reset the database in demo mode.
 * Access is strictly restricted to demo mode (DEMO_MODE=true).
 */

import { t } from "#i18n";
import { errorRedirect, notFoundResponse, redirect } from "#routes/response.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
/* jscpd:ignore-start */
import { createFormRoute, publicFormPage } from "#shared/app-forms.ts";
import { clearSessionCookie } from "#shared/cookies.ts";
import { getAllImages } from "#shared/db/images.ts";
import { getAllListings } from "#shared/db/listings/records.ts";
import { resetDatabase } from "#shared/db/migrations.ts";
import { isDemoMode } from "#shared/demo/mode.ts";
import { defineForm } from "#shared/forms/definition.ts";
import { featureGate, type ResponseHandler } from "#shared/response-steps.ts";
import {
  deleteAllImageStorageFiles,
  deleteAllListingAttachmentFiles,
  isStorageEnabled,
} from "#shared/storage.ts";
import {
  demoResetPage,
  RESET_DATABASE_PHRASE,
  RESET_PHRASE_MISMATCH_ERROR,
} from "#templates/admin/database-reset.tsx";

/* jscpd:ignore-end */

/** Guard: require demo mode, else 404 */
const withDemoResetAccess = featureGate(isDemoMode, notFoundResponse);

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
    values.confirm_phrase !== RESET_DATABASE_PHRASE
      ? RESET_PHRASE_MISMATCH_ERROR
      : null,
});

/** Wrap a demo-reset handler behind the demo-mode gate (else 404). */
const demoResetRoute =
  (
    handle: ResponseHandler<[request: Request]>,
  ): ResponseHandler<[request: Request]> =>
  (request) =>
    withDemoResetAccess(() => handle(request));

/** Handle GET /demo/reset - show reset confirmation page */
const handleDemoResetGet = demoResetRoute((request) =>
  publicFormPage(request, () => demoResetPage()),
);

export const deleteStorageAndResetDatabase = async (): Promise<void> => {
  if (isStorageEnabled()) {
    await deleteAllListingAttachmentFiles(await getAllListings());
    await deleteAllImageStorageFiles(await getAllImages());
  }
  await resetDatabase();
};

const resetRoute = createFormRoute({
  form: demoResetForm,
  onInvalid: ({ error }) => errorRedirect("/demo/reset", error),
  onValid: async () => {
    await deleteStorageAndResetDatabase();
    return redirect("/setup/", t("success.database_reset"), true, {
      cookie: clearSessionCookie(),
    });
  },
});

/** Handle POST /demo/reset - reset the database */
const handleDemoResetPost = demoResetRoute((request) =>
  resetRoute(request, {}),
);

/** Demo reset routes */
export const demoResetRoutes = defineRoutes({
  "GET /demo/reset": handleDemoResetGet,
  "POST /demo/reset": handleDemoResetPost,
});

export const routeDatabaseReset = createRouter(demoResetRoutes);
