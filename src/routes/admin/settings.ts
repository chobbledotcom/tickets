/**
 * Admin settings routes - password, payment provider, and key configuration
 * Owner-only access enforced via requireOwnerOr / withOwnerAuthForm
 */

import {
  clearPaymentProvider,
  getEmbedHostsFromDb,
  getPaymentProviderFromDb,
  getStripeWebhookEndpointId,
  getTermsAndConditionsFromDb,
  getTimezoneFromDb,
  MAX_TERMS_LENGTH,
  hasSquareToken,
  hasStripeKey,
  setPaymentProvider,
  setStripeWebhookConfig,
  updateEmbedHosts,
  updateSquareAccessToken,
  updateSquareLocationId,
  updateSquareWebhookSignatureKey,
  updateStripeKey,
  updateTermsAndConditions,
  updateTimezone,
  updateUserPassword,
} from "#lib/db/settings.ts";
import { getBusinessEmailFromDb, updateBusinessEmail, isValidBusinessEmail } from "#lib/business-email.ts";
import {
  getSquareWebhookSignatureKey,
  getAllowedDomain,
} from "#lib/config.ts";
import { isValidTimezone } from "#lib/timezone.ts";
import { validateEmbedHosts, parseEmbedHosts } from "#lib/embed-hosts.ts";
import { resetDatabase } from "#lib/db/migrations/index.ts";
import { getUserById, verifyUserPassword } from "#lib/db/users.ts";
import { validateForm } from "#lib/forms.tsx";
import { setupWebhookEndpoint, testStripeConnection } from "#lib/stripe.ts";
import type { PaymentProviderType } from "#lib/payments.ts";
import { buildClearedSessionCookie } from "#lib/cookies.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  type AuthSession,
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
  const termsAndConditions = await getTermsAndConditionsFromDb();
  const timezone = await getTimezoneFromDb();
  const businessEmail = await getBusinessEmailFromDb();
  return {
    stripeKeyConfigured,
    paymentProvider,
    squareTokenConfigured,
    squareWebhookConfigured,
    webhookUrl,
    embedHosts,
    termsAndConditions,
    timezone,
    businessEmail,
  };
};

/** Render the settings page with current state */
const renderSettingsPage = async (
  session: AuthSession,
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
    state.termsAndConditions,
    state.timezone,
    state.businessEmail,
  );
};

/** Render settings page with error at given status */
const settingsPageWithError = (session: AuthSession) =>
  async (error: string, status: number): Promise<Response> => {
    const html = await renderSettingsPage(session, error);
    return htmlResponse(html, status);
  };

type ErrorPageFn = (error: string, status: number) => Promise<Response>;
type SettingsFormHandler = (form: URLSearchParams, errorPage: ErrorPageFn, session: AuthSession) => Response | Promise<Response>;

/** Owner auth form route that provides the errorPage helper and session */
const settingsRoute = (handler: SettingsFormHandler) =>
  (request: Request): Promise<Response> =>
    withOwnerAuthForm(request, (session, form) =>
      handler(form, settingsPageWithError(session), session));

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
const handleAdminSettingsPost = settingsRoute(async (form, errorPage, session) => {
  const validation = validateChangePasswordForm(form);
  if (!validation.valid) {
    return errorPage(validation.error, 400);
  }

  // Load current user (guaranteed to exist since session was just validated)
  const user = (await getUserById(session.userId))!;

  const passwordHash = await verifyUserPassword(user, validation.currentPassword);
  if (!passwordHash) {
    return errorPage("Current password is incorrect", 401);
  }

  const success = await updateUserPassword(
    session.userId,
    passwordHash,
    user.wrapped_data_key!,
    validation.newPassword,
  );
  if (!success) {
    return errorPage("Failed to update password", 500);
  }

  return redirect("/admin", buildClearedSessionCookie());
});

/** Valid payment provider values from the form */
const VALID_PROVIDERS: ReadonlySet<string> = new Set<PaymentProviderType>([
  "stripe",
  "square",
]);

/**
 * Handle POST /admin/settings/payment-provider - owner only
 */
const handlePaymentProviderPost = settingsRoute(async (form, errorPage) => {
  const provider = form.get("payment_provider") ?? "";

  if (provider === "none") {
    await clearPaymentProvider();
    return redirectWithSuccess("/admin/settings", "Payment provider disabled");
  }

  if (!VALID_PROVIDERS.has(provider)) {
    return errorPage("Invalid payment provider", 400);
  }

  await setPaymentProvider(provider);

  return redirectWithSuccess("/admin/settings", `Payment provider set to ${provider}`);
});

/**
 * Handle POST /admin/settings/stripe - owner only
 */
const handleAdminStripePost = settingsRoute(async (form, errorPage) => {
  const validation = validateForm<StripeKeyFormValues>(form, stripeKeyFields);
  if (!validation.valid) {
    return errorPage(validation.error, 400);
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
    return errorPage(
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
const handleAdminSquarePost = settingsRoute(async (form, errorPage) => {
  const validation = validateForm<SquareTokenFormValues>(form, squareAccessTokenFields);
  if (!validation.valid) {
    return errorPage(validation.error, 400);
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
const handleAdminSquareWebhookPost = settingsRoute(async (form, errorPage) => {
  const validation = validateForm<SquareWebhookFormValues>(form, squareWebhookFields);
  if (!validation.valid) {
    return errorPage(validation.error, 400);
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
const handleEmbedHostsPost = settingsRoute(async (form, errorPage) => {
  const raw = form.get("embed_hosts") ?? "";
  const trimmed = raw.trim();

  // Empty = clear restriction
  if (trimmed === "") {
    await updateEmbedHosts("");
    return redirectWithSuccess("/admin/settings", "Embed host restrictions removed");
  }

  const error = validateEmbedHosts(trimmed);
  if (error) {
    return errorPage(error, 400);
  }

  // Normalize: trim, lowercase, rejoin
  const normalized = parseEmbedHosts(trimmed).join(", ");
  await updateEmbedHosts(normalized);
  return redirectWithSuccess("/admin/settings", "Allowed embed hosts updated");
});

/**
 * Handle POST /admin/settings/terms - owner only
 */
const handleTermsPost = settingsRoute(async (form, errorPage) => {
  const raw = form.get("terms_and_conditions") ?? "";
  const trimmed = raw.trim();

  if (trimmed.length > MAX_TERMS_LENGTH) {
    return errorPage(
      `Terms must be ${MAX_TERMS_LENGTH} characters or fewer (currently ${trimmed.length})`,
      400,
    );
  }

  await updateTermsAndConditions(trimmed);

  if (trimmed === "") {
    return redirectWithSuccess("/admin/settings", "Terms and conditions removed");
  }
  return redirectWithSuccess("/admin/settings", "Terms and conditions updated");
});

/** Validate and save timezone from form submission */
const processTimezoneForm: SettingsFormHandler = async (form, errorPage) => {
  const trimmed = (form.get("timezone") || "").trim();

  if (trimmed === "") {
    return errorPage("Timezone is required", 400);
  }

  if (!isValidTimezone(trimmed)) {
    return errorPage(`Invalid timezone: ${trimmed}`, 400);
  }

  await updateTimezone(trimmed);
  return redirectWithSuccess("/admin/settings", "Timezone updated");
};

/** Handle POST /admin/settings/timezone - owner only */
const handleTimezonePost = settingsRoute(processTimezoneForm);

/** Validate and save business email from form submission */
const processBusinessEmailForm: SettingsFormHandler = async (form, errorPage) => {
  const raw = form.get("business_email") || "";
  const trimmed = raw.trim();

  // Allow empty (clearing the business email)
  if (trimmed === "") {
    await updateBusinessEmail("");
    return redirectWithSuccess("/admin/settings", "Business email cleared");
  }

  if (!isValidBusinessEmail(trimmed)) {
    return errorPage("Invalid email format. Please use format: name@domain.com", 400);
  }

  await updateBusinessEmail(trimmed);
  return redirectWithSuccess("/admin/settings", "Business email updated");
};

/** Handle POST /admin/settings/business-email - owner only */
const handleBusinessEmailPost = settingsRoute(processBusinessEmailForm);

/**
 * Expected confirmation phrase for database reset
 */
const RESET_DATABASE_PHRASE =
  "The site will be fully reset and all data will be lost.";

/**
 * Handle POST /admin/settings/reset-database - owner only
 */
const handleResetDatabasePost = settingsRoute(async (form, errorPage) => {
  const confirmPhrase = form.get("confirm_phrase") ?? "";
  if (confirmPhrase.trim() !== RESET_DATABASE_PHRASE) {
    return errorPage(
      "Confirmation phrase does not match. Please type the exact phrase to confirm reset.",
      400,
    );
  }

  await resetDatabase();

  // Redirect to setup page since the database is now empty
  return redirect("/setup/", buildClearedSessionCookie());
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
  "POST /admin/settings/terms": (request) => handleTermsPost(request),
  "POST /admin/settings/timezone": (request) => handleTimezonePost(request),
  "POST /admin/settings/business-email": (request) => handleBusinessEmailPost(request),
  "POST /admin/settings/reset-database": (request) =>
    handleResetDatabasePost(request),
});
