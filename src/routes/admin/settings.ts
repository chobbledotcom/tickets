/**
 * Admin settings routes - password, payment provider, and key configuration
 * Owner-only access enforced via requireOwnerOr / withOwnerAuthForm
 */

import {
  isValidPemCertificate,
  isValidPemPrivateKey,
} from "#lib/apple-wallet.ts";
import { validateCustomDomain } from "#lib/bunny-cdn.ts";
import {
  getBusinessEmailFromDb,
  isValidBusinessEmail,
  updateBusinessEmail,
} from "#lib/business-email.ts";
import {
  getAllowedDomain,
  getCdnHostname,
  getSquareWebhookSignatureKey,
  isBunnyCdnEnabled,
} from "#lib/config.ts";
import { clearSessionCookie } from "#lib/cookies.ts";
import { logActivity } from "#lib/db/activityLog.ts";
import { resetDatabase } from "#lib/db/migrations.ts";
import {
  clearPaymentProvider,
  type EmailTemplateType,
  getAppleWalletPassTypeIdFromDb,
  getAppleWalletTeamIdFromDb,
  getCustomDomainFromDb,
  getCustomDomainLastValidatedFromDb,
  getEmailFromAddressFromDb,
  getEmailProviderFromDb,
  getEmailTemplateSet,
  getEmbedHostsFromDb,
  getHeaderImageUrlFromDb,
  getHostAppleWalletConfig,
  getPaymentProviderFromDb,
  getPhonePrefixFromDb,
  getShowPublicApiFromDb,
  getShowPublicSiteFromDb,
  getSquareSandboxFromDb,
  getStripeWebhookEndpointId,
  getTermsAndConditionsFromDb,
  getThemeFromDb,
  getTimezoneFromDb,
  hasAppleWalletDbConfig,
  hasEmailApiKey,
  hasSquareToken,
  hasStripeKey,
  isMaskSentinel,
  MAX_EMAIL_TEMPLATE_LENGTH,
  MAX_TERMS_LENGTH,
  setPaymentProvider,
  setStripeWebhookConfig,
  updateAppleWalletPassTypeId,
  updateAppleWalletSigningCert,
  updateAppleWalletSigningKey,
  updateAppleWalletTeamId,
  updateAppleWalletWwdrCert,
  updateCustomDomain,
  updateCustomDomainLastValidated,
  updateEmailApiKey,
  updateEmailFromAddress,
  updateEmailProvider,
  updateEmailTemplate,
  updateEmbedHosts,
  updateHeaderImageUrl,
  updatePhonePrefix,
  updateShowPublicApi,
  updateShowPublicSite,
  updateSquareAccessToken,
  updateSquareLocationId,
  updateSquareSandbox,
  updateSquareWebhookSignatureKey,
  updateStripeKey,
  updateTermsAndConditions,
  updateTheme,
  updateTimezone,
  updateUserPassword,
} from "#lib/db/settings.ts";
import { getUserById, verifyUserPassword } from "#lib/db/users.ts";
import {
  applyDemoOverrides,
  isDemoMode,
  TERMS_DEMO_FIELDS,
} from "#lib/demo.ts";
import {
  EMAIL_PROVIDER_LABELS,
  getEmailConfig,
  getHostEmailConfig,
  isEmailProvider,
  sendTestEmail,
} from "#lib/email.ts";
import {
  buildTemplateData,
  renderTemplate,
  validateTemplate,
} from "#lib/email-renderer.ts";
import {
  DOMAIN_PATTERN,
  parseEmbedHosts,
  validateEmbedHosts,
} from "#lib/embed-hosts.ts";
import { setFormError, setFormSuccess, validateForm } from "#lib/forms.tsx";
import type { PaymentProviderType } from "#lib/payments.ts";
import {
  IMAGE_ERROR_MESSAGES,
  isStorageEnabled,
  tryDeleteImage,
  uploadImage,
  validateImage,
} from "#lib/storage.ts";
import { setupWebhookEndpoint, testStripeConnection } from "#lib/stripe.ts";
import { isValidTimezone } from "#lib/timezone.ts";
import { validateResetPhrase } from "#routes/admin/database-reset.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import {
  type AuthSession,
  getSearchParam,
  htmlResponse,
  jsonResponse,
  redirect,
  requireOwnerOr,
  withOwnerAuthForm,
  withOwnerAuthMultipartForm,
} from "#routes/utils.ts";
import { adminSettingsPage } from "#templates/admin/settings.tsx";
import { adminAdvancedSettingsPage } from "#templates/admin/settings-advanced.tsx";
import {
  type ChangePasswordFormValues,
  changePasswordFields,
} from "#templates/fields.ts";

/** Build the webhook URL from the configured domain */
const getWebhookUrl = (): string => {
  const domain = getAllowedDomain();
  return `https://${domain}/payment/webhook`;
};

/** Gather all state needed to render the settings page.
 * All calls are independent, so we fetch them concurrently with Promise.all
 * to reduce sequential await overhead (especially for calls that decrypt).
 */
const getSettingsPageState = async () => {
  const [
    stripeKeyConfigured,
    paymentProvider,
    squareTokenConfigured,
    squareSandbox,
    squareWebhookKey,
    embedHosts,
    termsAndConditions,
    businessEmail,
    theme,
    showPublicSite,
    phonePrefix,
    headerImageUrl,
  ] = await Promise.all([
    hasStripeKey(),
    getPaymentProviderFromDb(),
    hasSquareToken(),
    getSquareSandboxFromDb(),
    getSquareWebhookSignatureKey(),
    getEmbedHostsFromDb(),
    getTermsAndConditionsFromDb(),
    getBusinessEmailFromDb(),
    getThemeFromDb(),
    getShowPublicSiteFromDb(),
    getPhonePrefixFromDb(),
    getHeaderImageUrlFromDb(),
  ]);
  return {
    stripeKeyConfigured,
    paymentProvider: paymentProvider ?? "",
    squareTokenConfigured,
    squareSandbox,
    squareWebhookConfigured: squareWebhookKey !== null,
    webhookUrl: getWebhookUrl(),
    embedHosts: embedHosts ?? "",
    termsAndConditions: termsAndConditions ?? "",
    businessEmail,
    theme,
    showPublicSite,
    phonePrefix,
    headerImageUrl: headerImageUrl ?? "",
    storageEnabled: isStorageEnabled(),
  };
};

/** Gather state for the advanced settings page */
const getAdvancedSettingsPageState = async () => {
  const bunnyCdnConfigured = isBunnyCdnEnabled();
  const [
    timezone,
    showPublicApi,
    emailProvider,
    emailApiKeyConfigured,
    emailFromAddress,
    businessEmail,
    confirmationTemplates,
    adminTemplates,
    customDomain,
    customDomainLastValidated,
    appleWalletConfigured,
    appleWalletPassTypeId,
    appleWalletTeamId,
    theme,
  ] = await Promise.all([
    getTimezoneFromDb(),
    getShowPublicApiFromDb(),
    getEmailProviderFromDb(),
    hasEmailApiKey(),
    getEmailFromAddressFromDb(),
    getBusinessEmailFromDb(),
    getEmailTemplateSet("confirmation"),
    getEmailTemplateSet("admin"),
    bunnyCdnConfigured ? getCustomDomainFromDb() : Promise.resolve(null),
    bunnyCdnConfigured
      ? getCustomDomainLastValidatedFromDb()
      : Promise.resolve(null),
    hasAppleWalletDbConfig(),
    getAppleWalletPassTypeIdFromDb(),
    getAppleWalletTeamIdFromDb(),
    getThemeFromDb(),
  ]);
  return {
    timezone,
    showPublicApi,
    emailProvider: emailProvider ?? "",
    emailApiKeyConfigured,
    emailFromAddress: emailFromAddress ?? "",
    hostEmailLabel: (() => {
      const hostConfig = getHostEmailConfig();
      if (!hostConfig) return "";
      const label = EMAIL_PROVIDER_LABELS[hostConfig.provider];
      return `Host ${label} (${hostConfig.fromAddress})`;
    })(),
    businessEmail,
    confirmationTemplates: {
      subject: confirmationTemplates.subject ?? "",
      html: confirmationTemplates.html ?? "",
      text: confirmationTemplates.text ?? "",
    },
    adminTemplates: {
      subject: adminTemplates.subject ?? "",
      html: adminTemplates.html ?? "",
      text: adminTemplates.text ?? "",
    },
    bunnyCdnEnabled: bunnyCdnConfigured,
    customDomain: customDomain ?? "",
    customDomainLastValidated: customDomainLastValidated ?? "",
    cdnHostname: bunnyCdnConfigured ? getCdnHostname() : "",
    appleWalletConfigured,
    appleWalletPassTypeId: appleWalletPassTypeId ?? "",
    appleWalletTeamId: appleWalletTeamId ?? "",
    hostAppleWalletLabel: (() => {
      const hostConfig = getHostAppleWalletConfig();
      if (!hostConfig) return "";
      return `Host env (${hostConfig.passTypeId})`;
    })(),
    theme,
  };
};

/** Render the settings page with current state */
const renderSettingsPage = async (session: AuthSession) => {
  const state = await getSettingsPageState();
  return adminSettingsPage(session, state);
};

/** Render the advanced settings page with current state */
const renderAdvancedSettingsPage = async (session: AuthSession) => {
  const state = await getAdvancedSettingsPageState();
  return adminAdvancedSettingsPage(session, state);
};

/** Render settings page with error on a specific form */
const settingsPageWithError =
  (session: AuthSession) =>
  async (error: string, status: number, formId: string): Promise<Response> => {
    setFormError(formId, error);
    const html = await renderSettingsPage(session);
    return htmlResponse(html, status);
  };

/** Render advanced settings page with error on a specific form */
const advancedSettingsPageWithError =
  (session: AuthSession) =>
  async (error: string, status: number, formId: string): Promise<Response> => {
    setFormError(formId, error);
    const html = await renderAdvancedSettingsPage(session);
    return htmlResponse(html, status);
  };

type ErrorPageFn = (
  error: string,
  status: number,
  formId: string,
) => Promise<Response>;
type SettingsFormHandler = (
  form: URLSearchParams,
  errorPage: ErrorPageFn,
  session: AuthSession,
) => Response | Promise<Response>;

/**
 * Result of processing a secret form field.
 * - "unchanged": sentinel detected → keep existing value
 * - "cleared": empty value submitted → caller decides (error if required, skip if optional)
 * - "provided": new non-empty value submitted → update
 */
export type SecretFieldResult =
  | { action: "unchanged" }
  | { action: "cleared" }
  | { action: "provided"; value: string };

/** Extract and classify a secret field from a form submission.
 * Consistently handles: trim → sentinel detection → empty vs provided.
 */
export const processSecretField = (
  form: URLSearchParams,
  fieldName: string,
): SecretFieldResult => {
  const raw = (form.get(fieldName) ?? "").trim();
  if (isMaskSentinel(raw)) return { action: "unchanged" };
  if (!raw) return { action: "cleared" };
  return { action: "provided", value: raw };
};

/** Owner auth form route that provides the errorPage helper and session */
const settingsRoute =
  (handler: SettingsFormHandler) =>
  (request: Request): Promise<Response> =>
    withOwnerAuthForm(request, (session, form) =>
      handler(form, settingsPageWithError(session), session),
    );

/** Owner auth form route for advanced settings - errors render the advanced page */
const advancedSettingsRoute =
  (handler: SettingsFormHandler) =>
  (request: Request): Promise<Response> =>
    withOwnerAuthForm(request, (session, form) =>
      handler(form, advancedSettingsPageWithError(session), session),
    );

/**
 * Handle GET /admin/settings - owner only
 */
const handleAdminSettingsGet: TypedRouteHandler<"GET /admin/settings"> = (
  request,
) =>
  requireOwnerOr(request, async (session) => {
    setFormSuccess(
      getSearchParam(request, "form"),
      getSearchParam(request, "success"),
    );
    return htmlResponse(await renderSettingsPage(session));
  });

/**
 * Handle GET /admin/settings-advanced - owner only
 */
const handleAdminSettingsAdvancedGet: TypedRouteHandler<
  "GET /admin/settings-advanced"
> = (request) =>
  requireOwnerOr(request, async (session) => {
    setFormSuccess(
      getSearchParam(request, "form"),
      getSearchParam(request, "success"),
    );
    return htmlResponse(await renderAdvancedSettingsPage(session));
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
  const validation = validateForm<ChangePasswordFormValues>(
    form,
    changePasswordFields,
  );
  if (!validation.valid) {
    return validation;
  }

  const { current_password, new_password, new_password_confirm } =
    validation.values;

  if (new_password.length < 8) {
    return {
      valid: false,
      error: "New password must be at least 8 characters",
    };
  }
  if (new_password !== new_password_confirm) {
    return { valid: false, error: "New passwords do not match" };
  }

  return {
    valid: true,
    currentPassword: current_password,
    newPassword: new_password,
  };
};

/**
 * Handle POST /admin/settings - change password (owner only)
 */
const handleAdminSettingsPost = settingsRoute(
  async (form, errorPage, session) => {
    const validation = validateChangePasswordForm(form);
    if (!validation.valid) {
      return errorPage(validation.error, 400, "settings-password");
    }

    // Load current user (guaranteed to exist since session was just validated)
    const user = (await getUserById(session.userId))!;

    const passwordHash = await verifyUserPassword(
      user,
      validation.currentPassword,
    );
    if (!passwordHash) {
      return errorPage(
        "Current password is incorrect",
        401,
        "settings-password",
      );
    }

    const success = await updateUserPassword(
      session.userId,
      passwordHash,
      user.wrapped_data_key!,
      validation.newPassword,
    );
    if (!success) {
      return errorPage("Failed to update password", 500, "settings-password");
    }

    await logActivity("Password changed");
    return redirect("/admin", "Password changed — please log in again", true, {
      cookie: clearSessionCookie(),
    });
  },
);

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
    await logActivity("Payment provider disabled");
    return redirect("/admin/settings", "Payment provider disabled", true, {
      formId: "settings-payment-provider",
    });
  }

  if (!VALID_PROVIDERS.has(provider)) {
    return errorPage(
      "Invalid payment provider",
      400,
      "settings-payment-provider",
    );
  }

  await setPaymentProvider(provider);
  await logActivity(`Payment provider set to ${provider}`);

  return redirect(
    "/admin/settings",
    `Payment provider set to ${provider}`,
    true,
    { formId: "settings-payment-provider" },
  );
});

/**
 * Handle POST /admin/settings/stripe - owner only
 */
const handleAdminStripePost = settingsRoute(async (form, errorPage) => {
  if (isDemoMode()) {
    return errorPage(
      "Cannot configure Stripe in demo mode",
      400,
      "settings-stripe",
    );
  }

  const field = processSecretField(form, "stripe_secret_key");

  if (field.action === "unchanged") {
    return redirect("/admin/settings", "Stripe settings unchanged", true, {
      formId: "settings-stripe",
    });
  }

  if (field.action === "cleared") {
    // Require a key when none is configured
    if (!(await hasStripeKey())) {
      return errorPage("Stripe Secret Key is required", 400, "settings-stripe");
    }
    // Empty with existing key = no change
    return redirect("/admin/settings", "Stripe settings unchanged", true, {
      formId: "settings-stripe",
    });
  }

  // Set up webhook endpoint automatically
  const webhookUrl = getWebhookUrl();
  const existingEndpointId = await getStripeWebhookEndpointId();

  const webhookResult = await setupWebhookEndpoint(
    field.value,
    webhookUrl,
    existingEndpointId,
  );

  if (!webhookResult.success) {
    return errorPage(
      `Failed to set up Stripe webhook: ${webhookResult.error}`,
      400,
      "settings-stripe",
    );
  }

  // Store both the Stripe key and webhook config
  await updateStripeKey(field.value);
  await setStripeWebhookConfig(webhookResult);

  // Auto-set payment provider to stripe when key is configured
  await setPaymentProvider("stripe");

  await logActivity("Stripe key configured");
  return redirect(
    "/admin/settings",
    "Stripe key updated and webhook configured successfully",
    true,
    { formId: "settings-stripe" },
  );
});

/**
 * Handle POST /admin/settings/square - owner only
 */
const handleAdminSquarePost = settingsRoute(async (form, errorPage) => {
  if (isDemoMode()) {
    return errorPage(
      "Cannot configure Square in demo mode",
      400,
      "settings-square",
    );
  }

  const tokenField = processSecretField(form, "square_access_token");
  const locationId = (form.get("square_location_id") || "").trim();
  const sandbox = form.get("square_sandbox") === "on";

  if (!locationId) {
    return errorPage("Location ID is required", 400, "settings-square");
  }

  // Require a token when none is configured
  if (tokenField.action === "cleared" && !(await hasSquareToken())) {
    return errorPage("Square Access Token is required", 400, "settings-square");
  }

  // Only update the token when a new value is provided
  if (tokenField.action === "provided") {
    await updateSquareAccessToken(tokenField.value);
  }

  // Always allow updating non-secret fields
  await updateSquareLocationId(locationId);
  await updateSquareSandbox(sandbox);

  // Auto-set payment provider to square when credentials are configured
  await setPaymentProvider("square");

  await logActivity("Square credentials configured");
  return redirect(
    "/admin/settings",
    "Square credentials updated successfully",
    true,
    { formId: "settings-square" },
  );
});

/**
 * Handle POST /admin/settings/square-webhook - owner only
 */
const handleAdminSquareWebhookPost = settingsRoute(async (form, errorPage) => {
  const field = processSecretField(form, "square_webhook_signature_key");

  if (field.action === "unchanged") {
    return redirect(
      "/admin/settings",
      "Square webhook settings unchanged",
      true,
      { formId: "settings-square-webhook" },
    );
  }

  if (field.action === "cleared") {
    return errorPage(
      "Webhook Signature Key is required",
      400,
      "settings-square-webhook",
    );
  }

  await updateSquareWebhookSignatureKey(field.value);

  await logActivity("Square webhook signature key configured");
  return redirect(
    "/admin/settings",
    "Square webhook signature key updated successfully",
    true,
    { formId: "settings-square-webhook" },
  );
});

/**
 * Handle POST /admin/settings/stripe/test - owner only
 */
const handleStripeTestPost = (request: Request): Promise<Response> =>
  withOwnerAuthForm(request, async () => {
    const result = await testStripeConnection();
    return jsonResponse(result);
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
    return redirect(
      "/admin/settings",
      "Embed host restrictions removed",
      true,
      { formId: "settings-embed-hosts" },
    );
  }

  const error = validateEmbedHosts(trimmed);
  if (error) {
    return errorPage(error, 400, "settings-embed-hosts");
  }

  // Normalize: trim, lowercase, rejoin
  const normalized = parseEmbedHosts(trimmed).join(", ");
  await updateEmbedHosts(normalized);
  return redirect("/admin/settings", "Allowed embed hosts updated", true, {
    formId: "settings-embed-hosts",
  });
});

/**
 * Handle POST /admin/settings/terms - owner only
 */
const handleTermsPost = settingsRoute(async (form, errorPage) => {
  applyDemoOverrides(form, TERMS_DEMO_FIELDS);
  const raw = form.get("terms_and_conditions") ?? "";
  const trimmed = raw.trim();

  if (trimmed.length > MAX_TERMS_LENGTH) {
    return errorPage(
      `Terms must be ${MAX_TERMS_LENGTH} characters or fewer (currently ${trimmed.length})`,
      400,
      "settings-terms",
    );
  }

  await updateTermsAndConditions(trimmed);

  if (trimmed === "") {
    await logActivity("Terms and conditions removed");
    return redirect("/admin/settings", "Terms and conditions removed", true, {
      formId: "settings-terms",
    });
  }
  await logActivity("Terms and conditions updated");
  return redirect("/admin/settings", "Terms and conditions updated", true, {
    formId: "settings-terms",
  });
});

/** Validate and save timezone from form submission */
const processTimezoneForm: SettingsFormHandler = async (form, errorPage) => {
  const trimmed = (form.get("timezone") || "").trim();

  if (trimmed === "") {
    return errorPage("Timezone is required", 400, "settings-timezone");
  }

  if (!isValidTimezone(trimmed)) {
    return errorPage(`Invalid timezone: ${trimmed}`, 400, "settings-timezone");
  }

  await updateTimezone(trimmed);
  await logActivity(`Timezone set to ${trimmed}`);
  return redirect("/admin/settings-advanced", "Timezone updated", true, {
    formId: "settings-timezone",
  });
};

/** Handle POST /admin/settings/timezone - owner only */
const handleTimezonePost = advancedSettingsRoute(processTimezoneForm);

/** Validate and save business email from form submission */
const processBusinessEmailForm: SettingsFormHandler = async (
  form,
  errorPage,
) => {
  const raw = form.get("business_email") || "";
  const trimmed = raw.trim();

  // Allow empty (clearing the business email)
  if (trimmed === "") {
    await updateBusinessEmail("");
    await logActivity("Business email cleared");
    return redirect("/admin/settings", "Business email cleared", true, {
      formId: "settings-business-email",
    });
  }

  if (!isValidBusinessEmail(trimmed)) {
    return errorPage(
      "Invalid email format. Please use format: name@domain.com",
      400,
      "settings-business-email",
    );
  }

  await updateBusinessEmail(trimmed);
  await logActivity("Business email updated");
  return redirect("/admin/settings", "Business email updated", true, {
    formId: "settings-business-email",
  });
};

/** Handle POST /admin/settings/business-email - owner only */
const handleBusinessEmailPost = settingsRoute(processBusinessEmailForm);

/** Validate and save theme from form submission */
const processThemeForm: SettingsFormHandler = async (form, errorPage) => {
  const theme = form.get("theme") ?? "";

  if (theme !== "light" && theme !== "dark") {
    return errorPage("Invalid theme selection", 400, "settings-theme");
  }

  await updateTheme(theme);
  await logActivity(`Theme set to ${theme}`);
  return redirect("/admin/settings", `Theme updated to ${theme}`, true, {
    formId: "settings-theme",
  });
};

/** Handle POST /admin/settings/theme - owner only */
const handleThemePost = settingsRoute(processThemeForm);

/** Validate and save show-public-site from form submission */
const processShowPublicSiteForm: SettingsFormHandler = async (form) => {
  const value = form.get("show_public_site") === "true";
  await updateShowPublicSite(value);
  await logActivity(`Public site ${value ? "enabled" : "disabled"}`);
  return redirect(
    "/admin/settings",
    value ? "Public site enabled" : "Public site disabled",
    true,
    { formId: "settings-show-public-site" },
  );
};

/** Handle POST /admin/settings/show-public-site - owner only */
const handleShowPublicSitePost = settingsRoute(processShowPublicSiteForm);

/** Validate and save show-public-api from form submission */
const processShowPublicApiForm: SettingsFormHandler = async (form) => {
  const value = form.get("show_public_api") === "true";
  await updateShowPublicApi(value);
  await logActivity(`Public API ${value ? "enabled" : "disabled"}`);
  return redirect(
    "/admin/settings-advanced",
    value ? "Public API enabled" : "Public API disabled",
    true,
    { formId: "settings-show-public-api" },
  );
};

/** Handle POST /admin/settings/show-public-api - owner only */
const handleShowPublicApiPost = advancedSettingsRoute(processShowPublicApiForm);

/** Validate and save phone prefix from form submission */
const processPhonePrefixForm: SettingsFormHandler = async (form, errorPage) => {
  const raw = (form.get("phone_prefix") ?? "").trim();

  if (raw === "" || !/^\d+$/.test(raw)) {
    return errorPage(
      "Phone prefix must be a number (digits only)",
      400,
      "settings-phone-prefix",
    );
  }

  await updatePhonePrefix(raw);
  await logActivity(`Phone prefix set to ${raw}`);
  return redirect("/admin/settings", `Phone prefix updated to ${raw}`, true, {
    formId: "settings-phone-prefix",
  });
};

/** Handle POST /admin/settings/phone-prefix - owner only */
const handlePhonePrefixPost = settingsRoute(processPhonePrefixForm);

/** Handle POST /admin/settings/header-image - owner only (multipart) */
const handleHeaderImagePost = (request: Request): Promise<Response> =>
  withOwnerAuthMultipartForm(request, async (session, formData) => {
    if (!isStorageEnabled()) {
      return htmlResponse("Image storage is not configured", 400);
    }

    const entry = formData.get("header_image");
    if (!(entry instanceof File) || entry.size === 0) {
      setFormError("settings-header-image", "No image file provided");
      return htmlResponse(await renderSettingsPage(session), 400);
    }

    const data = new Uint8Array(await entry.arrayBuffer());
    const validation = validateImage(data, entry.type);
    if (!validation.valid) {
      setFormError(
        "settings-header-image",
        IMAGE_ERROR_MESSAGES[validation.error],
      );
      return htmlResponse(await renderSettingsPage(session), 400);
    }

    // Delete old header image if one exists
    const existingUrl = await getHeaderImageUrlFromDb();
    if (existingUrl) {
      await tryDeleteImage(
        existingUrl,
        undefined,
        `header image: ${existingUrl}`,
      );
    }

    const filename = await uploadImage(data, validation.detectedType);
    await updateHeaderImageUrl(filename);
    await logActivity("Header image uploaded");
    return redirect("/admin/settings", "Header image uploaded", true, {
      formId: "settings-header-image",
    });
  });

/** Handle POST /admin/settings/header-image/delete - owner only */
const handleHeaderImageDeletePost = settingsRoute(async (_form, _errorPage) => {
  const existingUrl = await getHeaderImageUrlFromDb();
  if (!existingUrl) {
    return htmlResponse("No header image to remove", 400);
  }

  await tryDeleteImage(existingUrl, undefined, `header image: ${existingUrl}`);
  await updateHeaderImageUrl("");
  await logActivity("Header image removed");
  return redirect("/admin/settings", "Header image removed", true, {
    formId: "settings-header-image-delete",
  });
});

/** Handle POST /admin/settings/email - owner only */
const handleEmailPost = advancedSettingsRoute(async (form, errorPage) => {
  const provider = (form.get("email_provider") ?? "").trim();
  const apiKeyField = processSecretField(form, "email_api_key");
  const fromAddress = (form.get("email_from_address") ?? "").trim();

  if (provider === "") {
    await updateEmailProvider("");
    await updateEmailApiKey("");
    await updateEmailFromAddress("");
    await logActivity("Email provider disabled");
    return redirect(
      "/admin/settings-advanced",
      "Email provider disabled",
      true,
      { formId: "settings-email" },
    );
  }

  if (!isEmailProvider(provider)) {
    return errorPage("Invalid email provider", 400, "settings-email");
  }

  if (fromAddress && !isValidBusinessEmail(fromAddress)) {
    return errorPage(
      "Invalid from-address format. Please use format: name@domain.com",
      400,
      "settings-email",
    );
  }

  await updateEmailProvider(provider);
  if (apiKeyField.action === "provided")
    await updateEmailApiKey(apiKeyField.value);
  if (fromAddress) await updateEmailFromAddress(fromAddress);
  await logActivity(`Email provider set to ${provider}`);
  return redirect("/admin/settings-advanced", "Email settings updated", true, {
    formId: "settings-email",
  });
});

/** Handle POST /admin/settings/email/test - send test email to business email */
const handleEmailTestPost = advancedSettingsRoute(async (_form, errorPage) => {
  const config = await getEmailConfig();
  if (!config) return errorPage("Email not configured", 400, "settings-email");
  const businessEmail = await getBusinessEmailFromDb();
  if (!businessEmail)
    return errorPage("No business email set", 400, "settings-email-test");
  const status = await sendTestEmail(config, businessEmail);
  if (!status) {
    return errorPage(
      "Test email failed (no response)",
      502,
      "settings-email-test",
    );
  }
  if (status >= 300) {
    return errorPage(
      `Test email failed (status ${status})`,
      502,
      "settings-email-test",
    );
  }
  return redirect(
    "/admin/settings-advanced",
    `Test email sent (status ${status})`,
    true,
    { formId: "settings-email-test" },
  );
});

/** Valid template types for form submissions — derived from the EmailTemplateType union */
const VALID_TEMPLATE_TYPES: ReadonlySet<EmailTemplateType> =
  new Set<EmailTemplateType>(["confirmation", "admin"]);

/** Type guard: narrows a string to EmailTemplateType after Set membership check */
const isEmailTemplateType = (v: string): v is EmailTemplateType =>
  VALID_TEMPLATE_TYPES.has(v as EmailTemplateType);

/** Handle POST /admin/settings/email-templates/:type - save custom email templates */
const handleEmailTemplatePost = (type: EmailTemplateType) =>
  advancedSettingsRoute(async (form, errorPage) => {
    const formId = `settings-email-tpl-${type}`;
    const subject = form.get("subject") ?? "";
    const html = form.get("html") ?? "";
    const text = form.get("text") ?? "";

    // Validate lengths
    for (const [name, value] of [
      ["subject", subject],
      ["html", html],
      ["text", text],
    ] as const) {
      if (value.length > MAX_EMAIL_TEMPLATE_LENGTH) {
        return errorPage(
          `Template ${name} exceeds maximum length of ${MAX_EMAIL_TEMPLATE_LENGTH} characters`,
          400,
          formId,
        );
      }
    }

    // Validate Liquid syntax
    for (const [name, value] of [
      ["subject", subject],
      ["html", html],
      ["text", text],
    ] as const) {
      if (value) {
        const error = validateTemplate(value);
        if (error) {
          return errorPage(
            `Invalid template syntax in ${name}: ${error}`,
            400,
            formId,
          );
        }
      }
    }

    await Promise.all([
      updateEmailTemplate(type, "subject", subject.trim()),
      updateEmailTemplate(type, "html", html.trim()),
      updateEmailTemplate(type, "text", text.trim()),
    ]);

    const label =
      type === "confirmation" ? "Confirmation" : "Admin notification";
    await logActivity(`${label} email template updated`);
    return redirect(
      "/admin/settings-advanced",
      `${label} email template updated`,
      true,
      { formId },
    );
  });

/** Sample booking data used for email template previews */
const PREVIEW_BOOKINGS = [
  {
    event: {
      id: 1,
      name: "Summer Concert",
      slug: "summer-concert",
      webhook_url: "",
      max_attendees: 100,
      attendee_count: 42,
      unit_price: 2500,
      can_pay_more: false,
      date: "2026-07-15T19:00:00Z",
      location: "Town Hall",
    },
    attendee: {
      id: 1,
      name: "Jane Smith",
      email: "jane@example.com",
      phone: "+44 7700 900000",
      address: "123 High Street, London",
      special_instructions: "Wheelchair access please",
      quantity: 2,
      payment_id: "pi_sample",
      price_paid: "5000",
      ticket_token: "SAMPLE123",
      date: null,
    },
  },
  {
    event: {
      id: 2,
      name: "Workshop",
      slug: "workshop",
      webhook_url: "",
      max_attendees: 20,
      attendee_count: 8,
      unit_price: 0,
      can_pay_more: false,
      date: "",
      location: "",
    },
    attendee: {
      id: 2,
      name: "Jane Smith",
      email: "jane@example.com",
      phone: "+44 7700 900000",
      address: "123 High Street, London",
      special_instructions: "Wheelchair access please",
      quantity: 1,
      payment_id: "",
      price_paid: "0",
      ticket_token: "SAMPLE456",
      date: "2026-04-15",
    },
  },
];

const PREVIEW_CURRENCY = "GBP";
const PREVIEW_TICKET_URL = "https://example.com/t/SAMPLE123+SAMPLE456";

/** Handle POST /admin/settings/email-templates/preview - render template with sample data */
const handleEmailTemplatePreviewPost = (request: Request): Promise<Response> =>
  withOwnerAuthForm(request, async (_session, form) => {
    const type = form.get("type") ?? "";
    const template = form.get("template") ?? "";
    const format = form.get("format") ?? "html";

    if (!isEmailTemplateType(type)) {
      return jsonResponse({ error: "Invalid template type" }, 400);
    }

    const error = validateTemplate(template);
    if (error) {
      return jsonResponse({ error: `Template syntax error: ${error}` }, 400);
    }

    const sampleData = buildTemplateData(
      PREVIEW_BOOKINGS,
      PREVIEW_CURRENCY,
      PREVIEW_TICKET_URL,
    );

    try {
      const rendered = await renderTemplate(template, sampleData);
      return jsonResponse({ rendered, format });
    } catch (err) {
      return jsonResponse({ error: String(err) }, 400);
    }
  });

/** Handle POST /admin/settings/custom-domain - save custom domain */
const handleCustomDomainPost = advancedSettingsRoute(
  async (form, errorPage) => {
    if (!isBunnyCdnEnabled()) {
      return errorPage(
        "Bunny CDN is not configured",
        400,
        "settings-custom-domain",
      );
    }

    const raw = (form.get("custom_domain") ?? "").trim().toLowerCase();

    if (raw === "") {
      await updateCustomDomain("");
      await logActivity("Custom domain cleared");
      return redirect(
        "/admin/settings-advanced",
        "Custom domain cleared",
        true,
        { formId: "settings-custom-domain" },
      );
    }

    // Basic domain validation: must look like a hostname
    if (!DOMAIN_PATTERN.test(raw)) {
      return errorPage("Invalid domain format", 400, "settings-custom-domain");
    }

    await updateCustomDomain(raw);
    await logActivity(`Custom domain set to ${raw}`);

    // Attempt validation immediately after saving
    const result = await validateCustomDomain(raw);
    if (result.ok) {
      await updateCustomDomainLastValidated();
      await logActivity(`Custom domain validated: ${raw}`);
      return redirect(
        "/admin/settings-advanced",
        "Custom domain saved and validated",
        true,
        { formId: "settings-custom-domain" },
      );
    }

    return redirect(
      "/admin/settings-advanced",
      `Custom domain saved but validation failed: ${result.error}`,
      false,
      { formId: "settings-custom-domain" },
    );
  },
);

/** Handle POST /admin/settings/custom-domain/validate - validate with Bunny CDN */
const handleCustomDomainValidatePost = advancedSettingsRoute(
  async (_form, errorPage) => {
    if (!isBunnyCdnEnabled()) {
      return errorPage(
        "Bunny CDN is not configured",
        400,
        "settings-custom-domain-validate",
      );
    }

    const customDomain = await getCustomDomainFromDb();
    if (!customDomain) {
      return errorPage(
        "No custom domain is configured",
        400,
        "settings-custom-domain-validate",
      );
    }

    const result = await validateCustomDomain(customDomain);
    if (!result.ok) {
      return errorPage(result.error, 502, "settings-custom-domain-validate");
    }

    await updateCustomDomainLastValidated();
    await logActivity(`Custom domain validated: ${customDomain}`);
    return redirect(
      "/admin/settings-advanced",
      "Custom domain validated successfully",
      true,
      { formId: "settings-custom-domain-validate" },
    );
  },
);

/**
 * Handle POST /admin/settings/apple-wallet - owner only
 */
const handleAppleWalletPost = advancedSettingsRoute(async (form, errorPage) => {
  const passTypeId = `${form.get("apple_wallet_pass_type_id")}`.trim();
  const teamId = `${form.get("apple_wallet_team_id")}`.trim();
  const certField = processSecretField(form, "apple_wallet_signing_cert");
  const keyField = processSecretField(form, "apple_wallet_signing_key");
  const wwdrField = processSecretField(form, "apple_wallet_wwdr_cert");

  // If everything is cleared, remove all settings
  if (
    !passTypeId &&
    !teamId &&
    certField.action === "cleared" &&
    keyField.action === "cleared" &&
    wwdrField.action === "cleared"
  ) {
    await Promise.all([
      updateAppleWalletPassTypeId(""),
      updateAppleWalletTeamId(""),
      updateAppleWalletSigningCert(""),
      updateAppleWalletSigningKey(""),
      updateAppleWalletWwdrCert(""),
    ]);
    await logActivity("Apple Wallet configuration cleared");
    return redirect(
      "/admin/settings-advanced",
      "Apple Wallet configuration cleared",
      true,
      { formId: "settings-apple-wallet" },
    );
  }

  if (!passTypeId) {
    return errorPage("Pass Type ID is required", 400, "settings-apple-wallet");
  }

  if (!teamId) {
    return errorPage("Team ID is required", 400, "settings-apple-wallet");
  }

  // For initial setup, require all three PEM fields
  const isConfigured = await hasAppleWalletDbConfig();
  if (!isConfigured) {
    if (certField.action !== "provided") {
      return errorPage(
        "Signing certificate is required",
        400,
        "settings-apple-wallet",
      );
    }
    if (keyField.action !== "provided") {
      return errorPage(
        "Signing private key is required",
        400,
        "settings-apple-wallet",
      );
    }
    if (wwdrField.action !== "provided") {
      return errorPage(
        "WWDR certificate is required",
        400,
        "settings-apple-wallet",
      );
    }
  }

  // Validate PEM format for any newly provided fields
  if (
    certField.action === "provided" &&
    !isValidPemCertificate(certField.value)
  ) {
    return errorPage(
      "Signing certificate is not a valid PEM certificate",
      400,
      "settings-apple-wallet",
    );
  }
  if (keyField.action === "provided" && !isValidPemPrivateKey(keyField.value)) {
    return errorPage(
      "Signing private key is not a valid PEM private key",
      400,
      "settings-apple-wallet",
    );
  }
  if (
    wwdrField.action === "provided" &&
    !isValidPemCertificate(wwdrField.value)
  ) {
    return errorPage(
      "WWDR certificate is not a valid PEM certificate",
      400,
      "settings-apple-wallet",
    );
  }

  await updateAppleWalletPassTypeId(passTypeId);
  await updateAppleWalletTeamId(teamId);
  if (certField.action === "provided")
    await updateAppleWalletSigningCert(certField.value);
  if (keyField.action === "provided")
    await updateAppleWalletSigningKey(keyField.value);
  if (wwdrField.action === "provided")
    await updateAppleWalletWwdrCert(wwdrField.value);

  await logActivity("Apple Wallet configuration updated");
  return redirect(
    "/admin/settings-advanced",
    "Apple Wallet settings updated",
    true,
    { formId: "settings-apple-wallet" },
  );
});

/**
 * Handle POST /admin/settings/reset-database - owner only
 */
const handleResetDatabasePost = advancedSettingsRoute(
  async (form, errorPage) => {
    const phraseError = validateResetPhrase(form);
    if (phraseError)
      return errorPage(phraseError, 400, "settings-reset-database");

    await logActivity("Database reset initiated");
    await resetDatabase();

    // Redirect to setup page since the database is now empty
    return redirect("/setup/", "Database reset", true, {
      cookie: clearSessionCookie(),
    });
  },
);

/** Settings routes */
export const settingsRoutes = defineRoutes({
  "GET /admin/settings": handleAdminSettingsGet,
  "GET /admin/settings-advanced": handleAdminSettingsAdvancedGet,
  "POST /admin/settings": handleAdminSettingsPost,
  "POST /admin/settings/payment-provider": handlePaymentProviderPost,
  "POST /admin/settings/stripe": handleAdminStripePost,
  "POST /admin/settings/square": handleAdminSquarePost,
  "POST /admin/settings/square-webhook": handleAdminSquareWebhookPost,
  "POST /admin/settings/stripe/test": handleStripeTestPost,
  "POST /admin/settings/embed-hosts": handleEmbedHostsPost,
  "POST /admin/settings/terms": handleTermsPost,
  "POST /admin/settings/timezone": handleTimezonePost,
  "POST /admin/settings/business-email": handleBusinessEmailPost,
  "POST /admin/settings/theme": handleThemePost,
  "POST /admin/settings/show-public-site": handleShowPublicSitePost,
  "POST /admin/settings/show-public-api": handleShowPublicApiPost,
  "POST /admin/settings/phone-prefix": handlePhonePrefixPost,
  "POST /admin/settings/header-image": handleHeaderImagePost,
  "POST /admin/settings/header-image/delete": handleHeaderImageDeletePost,
  "POST /admin/settings/email": handleEmailPost,
  "POST /admin/settings/email/test": handleEmailTestPost,
  "POST /admin/settings/email-templates/confirmation":
    handleEmailTemplatePost("confirmation"),
  "POST /admin/settings/email-templates/admin":
    handleEmailTemplatePost("admin"),
  "POST /admin/settings/email-templates/preview":
    handleEmailTemplatePreviewPost,
  "POST /admin/settings/custom-domain": handleCustomDomainPost,
  "POST /admin/settings/custom-domain/validate": handleCustomDomainValidatePost,
  "POST /admin/settings/apple-wallet": handleAppleWalletPost,
  "POST /admin/settings/reset-database": handleResetDatabasePost,
});
