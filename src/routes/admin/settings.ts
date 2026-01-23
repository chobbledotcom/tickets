/**
 * Admin settings routes - password and Stripe configuration
 */

import {
  hasStripeKey,
  updateAdminPassword,
  updateStripeKey,
  verifyAdminPassword,
} from "#lib/db/settings.ts";
import { validateForm } from "#lib/forms.tsx";
import {
  type AuthValidationResult,
  clearSessionCookie,
  type FormFields,
  type ValidatedForm,
} from "#routes/admin/utils.ts";
import { defineRoutes } from "#routes/router.ts";
import type { AuthSession } from "#routes/utils.ts";
import {
  htmlResponse,
  redirect,
  requireAuthForm,
  requireSessionOr,
  withAuthForm,
} from "#routes/utils.ts";
import { adminSettingsPage } from "#templates/admin/settings.tsx";
import { changePasswordFields, stripeKeyFields } from "#templates/fields.ts";

/** Require auth + form + validation, with custom error handler */
const requireAuthValidation = async (
  request: Request,
  fields: FormFields,
  onError?: (
    session: AuthSession,
    form: URLSearchParams,
    error: string,
  ) => Response | Promise<Response>,
): Promise<AuthValidationResult> => {
  const auth = await requireAuthForm(request);
  if (!auth.ok) return auth;

  const validation = validateForm(auth.form, fields);
  if (!validation.valid) {
    const errorResponse = onError
      ? await onError(auth.session, auth.form, validation.error)
      : redirect("/admin/");
    return { ok: false, response: errorResponse };
  }

  return {
    ok: true,
    session: auth.session,
    validation: validation as ValidatedForm,
  };
};

/**
 * Handle GET /admin/settings
 */
const handleAdminSettingsGet = (request: Request): Promise<Response> =>
  requireSessionOr(request, async (session) =>
    htmlResponse(adminSettingsPage(session.csrfToken, await hasStripeKey())),
  );

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

    const isCurrentValid = await verifyAdminPassword(
      validation.currentPassword,
    );
    if (!isCurrentValid) {
      return settingsPageWithError("Current password is incorrect", 401);
    }

    await updateAdminPassword(validation.newPassword);
    return redirect("/admin/", clearSessionCookie);
  });

/**
 * Handle POST /admin/settings/stripe
 */
const handleAdminStripePost = async (request: Request): Promise<Response> => {
  const stripeErrorHandler = async (
    session: AuthSession,
    _: URLSearchParams,
    error: string,
  ) => {
    const stripeKeyConfigured = await hasStripeKey();
    return htmlResponse(
      adminSettingsPage(session.csrfToken, stripeKeyConfigured, error),
      400,
    );
  };

  const result = await requireAuthValidation(
    request,
    stripeKeyFields,
    stripeErrorHandler,
  );
  if (!result.ok) return result.response;

  await updateStripeKey(result.validation.values.stripe_secret_key as string);
  const stripeKeyConfigured = await hasStripeKey();
  return htmlResponse(
    adminSettingsPage(
      result.session.csrfToken,
      stripeKeyConfigured,
      undefined,
      "Stripe key updated successfully",
    ),
  );
};

/** Settings routes */
export const settingsRoutes = defineRoutes({
  "GET /admin/settings": (request) => handleAdminSettingsGet(request),
  "POST /admin/settings": (request) => handleAdminSettingsPost(request),
  "POST /admin/settings/stripe": (request) => handleAdminStripePost(request),
});
