/**
 * Admin settings routes - password and Stripe key configuration
 */

import {
  getStripeWebhookEndpointId,
  hasStripeKey,
  setStripeWebhookConfig,
  updateAdminPassword,
  updateStripeKey,
} from "#lib/db/settings.ts";
import { validateForm } from "#lib/forms.tsx";
import { setupWebhookEndpoint } from "#lib/stripe.ts";
import { getAllowedDomain } from "#lib/config.ts";
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
 *
 * When the Stripe secret key is saved, automatically creates/updates
 * a webhook endpoint in Stripe and stores the signing secret.
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

    // Set up webhook endpoint automatically
    const domain = getAllowedDomain();
    const webhookUrl = `https://${domain}/payment/webhook`;
    const existingEndpointId = await getStripeWebhookEndpointId();

    const webhookResult = await setupWebhookEndpoint(
      stripeSecretKey,
      webhookUrl,
      existingEndpointId,
    );

    if (!webhookResult.success) {
      return settingsPageWithError(
        `Failed to set up Stripe webhook: ${webhookResult.error}`,
        400,
      );
    }

    // Store both the Stripe key and webhook config
    await updateStripeKey(stripeSecretKey);
    await setStripeWebhookConfig(webhookResult.secret, webhookResult.endpointId);

    return htmlResponse(
      adminSettingsPage(
        session.csrfToken,
        true,
        undefined,
        "Stripe key updated and webhook configured successfully",
      ),
    );
  });

/** Settings routes */
export const settingsRoutes = defineRoutes({
  "GET /admin/settings": (request) => handleAdminSettingsGet(request),
  "POST /admin/settings": (request) => handleAdminSettingsPost(request),
  "POST /admin/settings/stripe": (request) => handleAdminStripePost(request),
});
