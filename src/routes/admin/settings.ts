/**
 * Admin settings routes - password, payment provider, and key configuration
 */

import {
  clearPaymentProvider,
  getPaymentProviderFromDb,
  getStripeWebhookEndpointId,
  hasSquareToken,
  hasStripeKey,
  setPaymentProvider,
  setStripeWebhookConfig,
  updateAdminPassword,
  updateSquareAccessToken,
  updateSquareLocationId,
  updateSquareWebhookSignatureKey,
  updateStripeKey,
} from "#lib/db/settings.ts";
import {
  getSquareWebhookSignatureKey,
  getAllowedDomain,
} from "#lib/config.ts";
import { resetDatabase } from "#lib/db/migrations/index.ts";
import { validateForm } from "#lib/forms.tsx";
import { setupWebhookEndpoint } from "#lib/stripe.ts";
import type { PaymentProviderType } from "#lib/payments.ts";
import { clearSessionCookie } from "#routes/admin/utils.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  htmlResponse,
  redirect,
  requireSessionOr,
  withAuthForm,
} from "#routes/utils.ts";
import { adminSettingsPage } from "#templates/admin/settings.tsx";
import {
  changePasswordFields,
  squareAccessTokenFields,
  squareWebhookFields,
  stripeKeyFields,
} from "#templates/fields.ts";

/** Build the webhook URL from the configured domain */
const getWebhookUrl = (): string => {
  const domain = getAllowedDomain();
  return `https://${domain}/payment/webhook`;
};

/** Gather all state needed to render the settings page */
const getSettingsPageState = async () => {
  const stripeKeyConfigured = await hasStripeKey();
  const paymentProvider = await getPaymentProviderFromDb();
  const squareTokenConfigured = await hasSquareToken();
  const squareWebhookKey = await getSquareWebhookSignatureKey();
  const squareWebhookConfigured = squareWebhookKey !== null;
  const webhookUrl = getWebhookUrl();
  return {
    stripeKeyConfigured,
    paymentProvider,
    squareTokenConfigured,
    squareWebhookConfigured,
    webhookUrl,
  };
};

/** Render the settings page with current state */
const renderSettingsPage = async (
  csrfToken: string,
  error?: string,
  success?: string,
) => {
  const state = await getSettingsPageState();
  return adminSettingsPage(
    csrfToken,
    state.stripeKeyConfigured,
    state.paymentProvider,
    error,
    success,
    state.squareTokenConfigured,
    state.squareWebhookConfigured,
    state.webhookUrl,
  );
};

/**
 * Handle GET /admin/settings
 */
const handleAdminSettingsGet = (request: Request): Promise<Response> =>
  requireSessionOr(request, async (session) =>
    htmlResponse(await renderSettingsPage(session.csrfToken)),
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
    const settingsPageWithError = async (error: string, status: number) =>
      htmlResponse(await renderSettingsPage(session.csrfToken, error), status);

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

/** Valid payment provider values from the form */
const VALID_PROVIDERS: ReadonlySet<string> = new Set<PaymentProviderType>([
  "stripe",
  "square",
]);

/**
 * Handle POST /admin/settings/payment-provider
 *
 * Sets the active payment provider. The provider's API keys must be
 * configured separately (e.g. via /admin/settings/stripe).
 */
const handlePaymentProviderPost = (request: Request): Promise<Response> =>
  withAuthForm(request, async (session, form) => {
    const settingsPageWithError = async (error: string, status: number) =>
      htmlResponse(await renderSettingsPage(session.csrfToken, error), status);

    const provider = form.get("payment_provider") ?? "";

    if (provider === "none") {
      await clearPaymentProvider();
      return htmlResponse(
        await renderSettingsPage(
          session.csrfToken,
          undefined,
          "Payment provider disabled",
        ),
      );
    }

    if (!VALID_PROVIDERS.has(provider)) {
      return settingsPageWithError("Invalid payment provider", 400);
    }

    await setPaymentProvider(provider);

    return htmlResponse(
      await renderSettingsPage(
        session.csrfToken,
        undefined,
        `Payment provider set to ${provider}`,
      ),
    );
  });

/**
 * Handle POST /admin/settings/stripe
 *
 * When the Stripe secret key is saved, automatically creates/updates
 * a webhook endpoint in Stripe and stores the signing secret.
 * Also sets the payment provider to "stripe" if not already set.
 */
const handleAdminStripePost = (request: Request): Promise<Response> =>
  withAuthForm(request, async (session, form) => {
    const settingsPageWithError = async (error: string, status: number) =>
      htmlResponse(await renderSettingsPage(session.csrfToken, error), status);

    const validation = validateForm(form, stripeKeyFields);
    if (!validation.valid) {
      return settingsPageWithError(validation.error, 400);
    }

    const stripeSecretKey = validation.values.stripe_secret_key as string;

    // Set up webhook endpoint automatically
    const webhookUrl = getWebhookUrl();
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

    // Auto-set payment provider to stripe when key is configured
    await setPaymentProvider("stripe");

    return htmlResponse(
      await renderSettingsPage(
        session.csrfToken,
        undefined,
        "Stripe key updated and webhook configured successfully",
      ),
    );
  });

/**
 * Handle POST /admin/settings/square
 *
 * Stores the Square access token and location ID.
 * Also sets the payment provider to "square".
 */
const handleAdminSquarePost = (request: Request): Promise<Response> =>
  withAuthForm(request, async (session, form) => {
    const settingsPageWithError = async (error: string, status: number) =>
      htmlResponse(await renderSettingsPage(session.csrfToken, error), status);

    const validation = validateForm(form, squareAccessTokenFields);
    if (!validation.valid) {
      return settingsPageWithError(validation.error, 400);
    }

    const accessToken = validation.values.square_access_token as string;
    const locationId = validation.values.square_location_id as string;

    await updateSquareAccessToken(accessToken);
    await updateSquareLocationId(locationId);

    // Auto-set payment provider to square when credentials are configured
    await setPaymentProvider("square");

    return htmlResponse(
      await renderSettingsPage(
        session.csrfToken,
        undefined,
        "Square credentials updated successfully",
      ),
    );
  });

/**
 * Handle POST /admin/settings/square-webhook
 *
 * Stores the Square webhook signature key (manually provided by user).
 */
const handleAdminSquareWebhookPost = (request: Request): Promise<Response> =>
  withAuthForm(request, async (session, form) => {
    const settingsPageWithError = async (error: string, status: number) =>
      htmlResponse(await renderSettingsPage(session.csrfToken, error), status);

    const validation = validateForm(form, squareWebhookFields);
    if (!validation.valid) {
      return settingsPageWithError(validation.error, 400);
    }

    const signatureKey = validation.values.square_webhook_signature_key as string;

    await updateSquareWebhookSignatureKey(signatureKey);

    return htmlResponse(
      await renderSettingsPage(
        session.csrfToken,
        undefined,
        "Square webhook signature key updated successfully",
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
    const settingsPageWithError = async (error: string, status: number) =>
      htmlResponse(await renderSettingsPage(session.csrfToken, error), status);

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
  "POST /admin/settings/payment-provider": (request) =>
    handlePaymentProviderPost(request),
  "POST /admin/settings/stripe": (request) => handleAdminStripePost(request),
  "POST /admin/settings/square": (request) => handleAdminSquarePost(request),
  "POST /admin/settings/square-webhook": (request) =>
    handleAdminSquareWebhookPost(request),
  "POST /admin/settings/reset-database": (request) =>
    handleResetDatabasePost(request),
});
