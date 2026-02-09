/**
 * Admin settings routes - password, payment provider, and key configuration
 * Owner-only access enforced via requireOwnerOr / withOwnerAuthForm
 */

import {
  clearPaymentProvider,
  getEmbedHostsFromDb,
  getPaymentProviderFromDb,
  getStripeWebhookEndpointId,
  hasSquareToken,
  hasStripeKey,
  setPaymentProvider,
  setStripeWebhookConfig,
  updateEmbedHosts,
  updateSquareAccessToken,
  updateSquareLocationId,
  updateSquareWebhookSignatureKey,
  updateStripeKey,
  updateUserPassword,
} from "#lib/db/settings.ts";
import {
  getSquareWebhookSignatureKey,
  getAllowedDomain,
} from "#lib/config.ts";
import { validateEmbedHosts, parseEmbedHosts } from "#lib/embed-hosts.ts";
import { resetDatabase } from "#lib/db/migrations/index.ts";
import { getUserById, verifyUserPassword } from "#lib/db/users.ts";
import { validateForm } from "#lib/forms.tsx";
import { setupWebhookEndpoint, testStripeConnection } from "#lib/stripe.ts";
import type { PaymentProviderType } from "#lib/payments.ts";
import type { AdminSession } from "#lib/types.ts";
import { clearSessionCookie } from "#routes/admin/utils.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  getSearchParam,
  htmlResponse,
  redirect,
  redirectWithSuccess,
  requireOwnerOr,
  withOwnerAuthForm,
} from "#routes/utils.ts";
import { adminSettingsPage } from "#templates/admin/settings.tsx";
import {
  changePasswordFields,
  type ChangePasswordFormValues,
  squareAccessTokenFields,
  type SquareTokenFormValues,
  squareWebhookFields,
  type SquareWebhookFormValues,
  stripeKeyFields,
  type StripeKeyFormValues,
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
  const embedHosts = await getEmbedHostsFromDb();
  return {
    stripeKeyConfigured,
    paymentProvider,
    squareTokenConfigured,
    squareWebhookConfigured,
    webhookUrl,
    embedHosts,
  };
};

/** Render the settings page with current state */
const renderSettingsPage = async (
  session: AdminSession,
  error?: string,
  success?: string,
) => {
  const state = await getSettingsPageState();
  return adminSettingsPage(
    session,
    state.stripeKeyConfigured,
    state.paymentProvider,
    error,
    success,
    state.squareTokenConfigured,
    state.squareWebhookConfigured,
    state.webhookUrl,
    state.embedHosts,
  );
};

/**
 * Handle GET /admin/settings - owner only
 */
const handleAdminSettingsGet = (request: Request): Promise<Response> =>
  requireOwnerOr(request, async (session) => {
    const success = getSearchParam(request, "success");
    return htmlResponse(
      await renderSettingsPage(session, undefined, success ?? undefined),
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
  const validation = validateForm<ChangePasswordFormValues>(form, changePasswordFields);
  if (!validation.valid) {
    return validation;
  }

  const { current_password, new_password, new_password_confirm } = validation.values;

  if (new_password.length < 8) {
    return {
      valid: false,
      error: "New password must be at least 8 characters",
    };
  }
  if (new_password !== new_password_confirm) {
    return { valid: false, error: "New passwords do not match" };
  }

  return { valid: true, currentPassword: current_password, newPassword: new_password };
};

/**
 * Handle POST /admin/settings - change password (owner only)
 */
const handleAdminSettingsPost = (request: Request): Promise<Response> =>
  withOwnerAuthForm(request, async (session, form) => {
    const settingsPageWithError = async (error: string, status: number) =>
      htmlResponse(await renderSettingsPage(session, error), status);

    const validation = validateChangePasswordForm(form);
    if (!validation.valid) {
      return settingsPageWithError(validation.error, 400);
    }

    // Load current user (guaranteed to exist since session was just validated)
    const user = (await getUserById(session.userId))!;

    const passwordHash = await verifyUserPassword(user, validation.currentPassword);
    if (!passwordHash) {
      return settingsPageWithError("Current password is incorrect", 401);
    }

    const success = await updateUserPassword(
      session.userId,
      passwordHash,
      user.wrapped_data_key!,
      validation.newPassword,
    );
    if (!success) {
      return settingsPageWithError("Failed to update password", 500);
    }

    return redirect("/admin", clearSessionCookie);
  });

/** Valid payment provider values from the form */
const VALID_PROVIDERS: ReadonlySet<string> = new Set<PaymentProviderType>([
  "stripe",
  "square",
]);

/**
 * Handle POST /admin/settings/payment-provider - owner only
 */
const handlePaymentProviderPost = (request: Request): Promise<Response> =>
  withOwnerAuthForm(request, async (session, form) => {
    const settingsPageWithError = async (error: string, status: number) =>
      htmlResponse(await renderSettingsPage(session, error), status);

    const provider = form.get("payment_provider") ?? "";

    if (provider === "none") {
      await clearPaymentProvider();
      return redirectWithSuccess("/admin/settings", "Payment provider disabled");
    }

    if (!VALID_PROVIDERS.has(provider)) {
      return settingsPageWithError("Invalid payment provider", 400);
    }

    await setPaymentProvider(provider);

    return redirectWithSuccess("/admin/settings", `Payment provider set to ${provider}`);
  });

/**
 * Handle POST /admin/settings/stripe - owner only
 */
const handleAdminStripePost = (request: Request): Promise<Response> =>
  withOwnerAuthForm(request, async (session, form) => {
    const settingsPageWithError = async (error: string, status: number) =>
      htmlResponse(await renderSettingsPage(session, error), status);

    const validation = validateForm<StripeKeyFormValues>(form, stripeKeyFields);
    if (!validation.valid) {
      return settingsPageWithError(validation.error, 400);
    }

    const { stripe_secret_key: stripeSecretKey } = validation.values;

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
    await setStripeWebhookConfig(webhookResult);

    // Auto-set payment provider to stripe when key is configured
    await setPaymentProvider("stripe");

    return redirectWithSuccess(
      "/admin/settings",
      "Stripe key updated and webhook configured successfully",
    );
  });

/**
 * Handle POST /admin/settings/square - owner only
 */
const handleAdminSquarePost = (request: Request): Promise<Response> =>
  withOwnerAuthForm(request, async (session, form) => {
    const settingsPageWithError = async (error: string, status: number) =>
      htmlResponse(await renderSettingsPage(session, error), status);

    const validation = validateForm<SquareTokenFormValues>(form, squareAccessTokenFields);
    if (!validation.valid) {
      return settingsPageWithError(validation.error, 400);
    }

    const { square_access_token: accessToken, square_location_id: locationId } = validation.values;

    await updateSquareAccessToken(accessToken);
    await updateSquareLocationId(locationId);

    // Auto-set payment provider to square when credentials are configured
    await setPaymentProvider("square");

    return redirectWithSuccess("/admin/settings", "Square credentials updated successfully");
  });

/**
 * Handle POST /admin/settings/square-webhook - owner only
 */
const handleAdminSquareWebhookPost = (request: Request): Promise<Response> =>
  withOwnerAuthForm(request, async (session, form) => {
    const settingsPageWithError = async (error: string, status: number) =>
      htmlResponse(await renderSettingsPage(session, error), status);

    const validation = validateForm<SquareWebhookFormValues>(form, squareWebhookFields);
    if (!validation.valid) {
      return settingsPageWithError(validation.error, 400);
    }

    const { square_webhook_signature_key: signatureKey } = validation.values;

    await updateSquareWebhookSignatureKey(signatureKey);

    return redirectWithSuccess(
      "/admin/settings",
      "Square webhook signature key updated successfully",
    );
  });

/**
 * Handle POST /admin/settings/stripe/test - owner only
 */
const handleStripeTestPost = (request: Request): Promise<Response> =>
  withOwnerAuthForm(request, async () => {
    const result = await testStripeConnection();
    return new Response(JSON.stringify(result), {
      headers: { "content-type": "application/json" },
    });
  });

/**
 * Handle POST /admin/settings/embed-hosts - owner only
 */
const handleEmbedHostsPost = (request: Request): Promise<Response> =>
  withOwnerAuthForm(request, async (session, form) => {
    const settingsPageWithError = async (error: string, status: number) =>
      htmlResponse(await renderSettingsPage(session, error), status);

    const raw = form.get("embed_hosts") ?? "";
    const trimmed = raw.trim();

    // Empty = clear restriction
    if (trimmed === "") {
      await updateEmbedHosts("");
      return redirectWithSuccess("/admin/settings", "Embed host restrictions removed");
    }

    const error = validateEmbedHosts(trimmed);
    if (error) {
      return settingsPageWithError(error, 400);
    }

    // Normalize: trim, lowercase, rejoin
    const normalized = parseEmbedHosts(trimmed).join(", ");
    await updateEmbedHosts(normalized);
    return redirectWithSuccess("/admin/settings", "Allowed embed hosts updated");
  });

/**
 * Expected confirmation phrase for database reset
 */
const RESET_DATABASE_PHRASE =
  "The site will be fully reset and all data will be lost.";

/**
 * Handle POST /admin/settings/reset-database - owner only
 */
const handleResetDatabasePost = (request: Request): Promise<Response> =>
  withOwnerAuthForm(request, async (session, form) => {
    const settingsPageWithError = async (error: string, status: number) =>
      htmlResponse(await renderSettingsPage(session, error), status);

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
  "POST /admin/settings/stripe/test": (request) => handleStripeTestPost(request),
  "POST /admin/settings/embed-hosts": (request) => handleEmbedHostsPost(request),
  "POST /admin/settings/reset-database": (request) =>
    handleResetDatabasePost(request),
});
