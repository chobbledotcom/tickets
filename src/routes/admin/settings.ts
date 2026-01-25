/**
 * Admin settings routes - password and Stripe key configuration
 */

import {
  hasStripeKey,
  updateAdminPassword,
  updateStripeKey,
} from "#lib/db/settings.ts";
import { resetDatabase } from "#lib/db/migrations/index.ts";
import { validateForm } from "#lib/forms.tsx";
import { clearSessionCookie } from "#routes/admin/utils.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  htmlResponse,
  redirect,
  requireSessionOr,
  withAuthForm,
} from "#routes/utils.ts";
import { adminSettingsPage } from "#templates/admin/settings.tsx";
import { changePasswordFields, stripeKeyFields } from "#templates/fields.ts";

/**
 * Handle GET /admin/settings
 */
const handleAdminSettingsGet = (request: Request): Promise<Response> =>
  requireSessionOr(request, async (session) => {
    const stripeKeyConfigured = await hasStripeKey();
    return htmlResponse(
      adminSettingsPage(session.csrfToken, stripeKeyConfigured),
    );
  });

/**
 * Validate change password form data
 */
type ChangePasswordValidation =
  | { valid: true; currentPassword: string; newPassword: string }
  | { valid: false; error: string };

const validateChangePasswordForm = (
  form: URLSearchParams,
): ChangePasswordValidation => {
  const validation = validateForm(form, changePasswordFields);
  if (!validation.valid) {
    return validation;
  }

  const { values } = validation;
  const currentPassword = values.current_password as string;
  const newPassword = values.new_password as string;
  const newPasswordConfirm = values.new_password_confirm as string;

  if (newPassword.length < 8) {
    return {
      valid: false,
      error: "New password must be at least 8 characters",
    };
  }
  if (newPassword !== newPasswordConfirm) {
    return { valid: false, error: "New passwords do not match" };
  }

  return { valid: true, currentPassword, newPassword };
};

/**
 * Handle POST /admin/settings
 */
const handleAdminSettingsPost = (request: Request): Promise<Response> =>
  withAuthForm(request, async (session, form) => {
    const stripeKeyConfigured = await hasStripeKey();
    const settingsPageWithError = (error: string, status: number) =>
      htmlResponse(
        adminSettingsPage(session.csrfToken, stripeKeyConfigured, error),
        status,
      );

    const validation = validateChangePasswordForm(form);
    if (!validation.valid) {
      return settingsPageWithError(validation.error, 400);
    }

    // updateAdminPassword now verifies old password and re-wraps DATA_KEY
    const success = await updateAdminPassword(
      validation.currentPassword,
      validation.newPassword,
    );
    if (!success) {
      return settingsPageWithError("Current password is incorrect", 401);
    }

    return redirect("/admin", clearSessionCookie);
  });

/**
 * Handle POST /admin/settings/stripe
 */
const handleAdminStripePost = (request: Request): Promise<Response> =>
  withAuthForm(request, async (session, form) => {
    const stripeKeyConfigured = await hasStripeKey();
    const settingsPageWithError = (error: string, status: number) =>
      htmlResponse(
        adminSettingsPage(session.csrfToken, stripeKeyConfigured, error),
        status,
      );

    const validation = validateForm(form, stripeKeyFields);
    if (!validation.valid) {
      return settingsPageWithError(validation.error, 400);
    }

    const stripeSecretKey = validation.values.stripe_secret_key as string;
    await updateStripeKey(stripeSecretKey);

    return htmlResponse(
      adminSettingsPage(
        session.csrfToken,
        true,
        undefined,
        "Stripe key updated successfully",
      ),
    );
  });

/**
 * Expected confirmation phrase for database reset
 */
const RESET_DATABASE_PHRASE =
  "The site will be fully reset and all data will be lost.";

/**
 * Handle POST /admin/settings/reset-database
 */
const handleResetDatabasePost = (request: Request): Promise<Response> =>
  withAuthForm(request, async (session, form) => {
    const stripeKeyConfigured = await hasStripeKey();
    const settingsPageWithError = (error: string, status: number) =>
      htmlResponse(
        adminSettingsPage(session.csrfToken, stripeKeyConfigured, error),
        status,
      );

    const confirmPhrase = form.get("confirm_phrase") ?? "";
    if (confirmPhrase.trim() !== RESET_DATABASE_PHRASE) {
      return settingsPageWithError(
        "Confirmation phrase does not match. Please type the exact phrase to confirm reset.",
        400,
      );
    }

    await resetDatabase();

    // Redirect to setup page since the database is now empty
    return redirect("/setup/", clearSessionCookie);
  });

/** Settings routes */
export const settingsRoutes = defineRoutes({
  "GET /admin/settings": (request) => handleAdminSettingsGet(request),
  "POST /admin/settings": (request) => handleAdminSettingsPost(request),
  "POST /admin/settings/stripe": (request) => handleAdminStripePost(request),
  "POST /admin/settings/reset-database": (request) =>
    handleResetDatabasePost(request),
});
