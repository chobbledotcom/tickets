/**
 * Admin settings routes - password, payment provider, and key configuration
 * Owner-only access enforced via requireOwnerOr / withAuth
 */

import {
  isValidPemCertificate,
  isValidPemPrivateKey,
} from "#lib/apple-wallet.ts";
import {
  checkSubdomainAvailable,
  getCdnHostname,
  registerBunnySubdomain,
  validateCustomDomain,
} from "#lib/bunny-cdn.ts";
import {
  isValidBusinessEmail,
  updateBusinessEmail,
} from "#lib/business-email.ts";
import {
  getBunnyDnsSubdomainSuffix,
  getEffectiveDomain,
  isBunnyCdnEnabled,
  isBunnyDnsEnabled,
} from "#lib/config.ts";
import { clearSessionCookie } from "#lib/cookies.ts";
import { isValidCountry } from "#lib/countries.ts";
import { logActivity } from "#lib/db/activityLog.ts";
import { getAllEvents } from "#lib/db/events.ts";
import { resetDatabase } from "#lib/db/migrations.ts";
import {
  type EmailTemplateType,
  MAX_EMAIL_TEMPLATE_LENGTH,
  settings,
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
import type { FormParams } from "#lib/form-data.ts";
import { validateForm } from "#lib/forms.tsx";
import { isValidGooglePrivateKey } from "#lib/google-wallet.ts";
import { MAX_TEXTAREA_LENGTH } from "#lib/limits.ts";
import { ErrorCode, logError } from "#lib/logger.ts";
import type { PaymentProviderType } from "#lib/payments.ts";
import { testSquareConnection } from "#lib/square.ts";
import {
  deleteAllEventStorageFiles,
  deleteImage,
  IMAGE_ERROR_MESSAGES,
  isStorageEnabled,
  tryDeleteImage,
  uploadImage,
  validateImage,
} from "#lib/storage.ts";
import {
  detectStripeKeyMode,
  setupWebhookEndpoint,
  testStripeConnection,
} from "#lib/stripe.ts";
import { validateResetPhrase } from "#routes/admin/database-reset.ts";
import {
  clearableFieldHandler,
  createSettingsHandler,
  processSecretField,
  type SettingsFormHandler,
  secretFieldHandler,
  toggleHandler,
} from "#routes/admin/settings-helpers.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import {
  type AuthSession,
  applyFlash,
  errorRedirect,
  htmlResponse,
  jsonResponse,
  OWNER_FORM,
  OWNER_MULTIPART,
  redirect,
  requireOwnerOr,
  withAuth,
} from "#routes/utils.ts";
import { adminSettingsPage } from "#templates/admin/settings.tsx";
import { adminAdvancedSettingsPage } from "#templates/admin/settings-advanced.tsx";
import {
  type ChangePasswordFormValues,
  changePasswordFields,
} from "#templates/fields.ts";

/** Build the webhook URL from the configured domain */
const getWebhookUrl = (): string => {
  const domain = getEffectiveDomain();
  return `https://${domain}/payment/webhook`;
};

/** Gather all state needed to render the settings page.
 * All calls are independent, so we fetch them concurrently with Promise.all
 * to reduce sequential await overhead (especially for calls that decrypt).
 */
const getSettingsPageState = () => {
  return {
    stripeKeyConfigured: settings.stripe.hasKey,
    stripeKeyMode: settings.stripe.keyMode,
    paymentProvider: settings.paymentProvider ?? "",
    squareTokenConfigured: settings.square.hasToken,
    squareSandbox: settings.square.sandbox,
    squareWebhookConfigured: settings.square.webhookSignatureKey !== "",
    webhookUrl: getWebhookUrl(),
    bookingFee: settings.bookingFee,
    embedHosts: settings.embedHosts,
    termsAndConditions: settings.terms,
    businessEmail: settings.businessEmail,
    theme: settings.theme,
    showPublicSite: settings.showPublicSite,
    country: settings.country,
    headerImageUrl: settings.headerImageUrl,
    storageEnabled: isStorageEnabled(),
  };
};

/** Gather state for the advanced settings page */
const getAdvancedSettingsPageState = async (
  subdomainPreview = "",
  subdomainPreviewFullDomain = "",
) => {
  const bunnyCdnConfigured = isBunnyCdnEnabled();
  const bunnyDnsEnabled = isBunnyDnsEnabled();
  const confirmationTemplates = settings.email.templateSet("confirmation");
  const adminTemplates = settings.email.templateSet("admin");
  const cdnResult = bunnyCdnConfigured ? await getCdnHostname() : null;
  return {
    showPublicApi: settings.showPublicApi,
    emailProvider: settings.email.provider,
    emailApiKeyConfigured: settings.email.hasApiKey,
    emailFromAddress: settings.email.fromAddress,
    hostEmailLabel: (() => {
      const hostConfig = getHostEmailConfig();
      if (!hostConfig) return "";
      const label = EMAIL_PROVIDER_LABELS[hostConfig.provider];
      return `Host ${label} (${hostConfig.fromAddress})`;
    })(),
    businessEmail: settings.businessEmail,
    confirmationTemplates,
    adminTemplates,
    bunnyCdnEnabled: bunnyCdnConfigured,
    bunnyDnsEnabled,
    bunnySubdomain: settings.bunnySubdomain,
    bunnyDnsSubdomainSuffix: bunnyDnsEnabled
      ? getBunnyDnsSubdomainSuffix()
      : "",
    subdomainPreview,
    subdomainPreviewFullDomain,
    customDomain: (bunnyCdnConfigured ? settings.customDomain : null) ?? "",
    customDomainLastValidated:
      (bunnyCdnConfigured ? settings.customDomainLastValidated : null) ?? "",
    cdnHostname: cdnResult?.ok ? cdnResult.hostname : "",
    appleWalletConfigured: settings.appleWallet.hasDbConfig,
    appleWalletPassTypeId: settings.appleWallet.passTypeId,
    appleWalletTeamId: settings.appleWallet.teamId,
    hostAppleWalletLabel: (() => {
      const hostConfig = settings.appleWallet.hostConfig;
      if (!hostConfig) return "";
      return `Host env (${hostConfig.passTypeId})`;
    })(),
    googleWalletConfigured: settings.googleWallet.hasDbConfig,
    googleWalletIssuerId: settings.googleWallet.issuerId,
    googleWalletServiceAccountEmail: settings.googleWallet.serviceAccountEmail,
    hostGoogleWalletLabel: (() => {
      const hostConfig = settings.googleWallet.hostConfig;
      if (!hostConfig) return "";
      return `Host env (${hostConfig.issuerId})`;
    })(),
    theme: settings.theme,
  };
};

/** Render the settings page with current state */
const renderSettingsPage = (session: AuthSession) => {
  const state = getSettingsPageState();
  return adminSettingsPage(session, state);
};

/** Render the advanced settings page with current state */
const renderAdvancedSettingsPage = async (
  session: AuthSession,
  subdomainPreview = "",
  subdomainPreviewFullDomain = "",
) => {
  const state = await getAdvancedSettingsPageState(
    subdomainPreview,
    subdomainPreviewFullDomain,
  );
  return adminAdvancedSettingsPage(session, state);
};

/** Redirect back to settings page with error flash (PRG pattern) */
const settingsPageWithError =
  (_session: AuthSession) =>
  (error: string, _status: number, formId: string): Response =>
    errorRedirect("/admin/settings", error, formId);

/** Redirect back to advanced settings page with error flash (PRG pattern) */
const advancedSettingsPageWithError =
  (_session: AuthSession) =>
  (error: string, _status: number, formId: string): Response =>
    errorRedirect("/admin/settings-advanced", error, formId);

export type { SecretFieldResult } from "#routes/admin/settings-helpers.ts";
export { processSecretField } from "#routes/admin/settings-helpers.ts";

/** Owner auth form route that provides the errorPage helper and session */
const settingsRoute =
  (handler: SettingsFormHandler) =>
  (request: Request): Promise<Response> =>
    withAuth(request, OWNER_FORM, (session, form) =>
      handler(form, settingsPageWithError(session), session),
    );

/** Owner auth form route for advanced settings - errors render the advanced page */
const advancedSettingsRoute =
  (handler: SettingsFormHandler) =>
  (request: Request): Promise<Response> =>
    withAuth(request, OWNER_FORM, (session, form) =>
      handler(form, advancedSettingsPageWithError(session), session),
    );

/**
 * Handle GET /admin/settings - owner only
 */
const handleAdminSettingsGet: TypedRouteHandler<"GET /admin/settings"> = (
  request,
) =>
  requireOwnerOr(request, async (session) => {
    applyFlash(request);
    return htmlResponse(await renderSettingsPage(session));
  });

/**
 * Handle GET /admin/settings-advanced - owner only
 */
const handleAdminSettingsAdvancedGet: TypedRouteHandler<
  "GET /admin/settings-advanced"
> = (request) =>
  requireOwnerOr(request, async (session) => {
    const flash = applyFlash(request);
    const [subdomainPreview = "", subdomainPreviewFullDomain = ""] =
      flash.result?.split("\n") ?? [];
    return htmlResponse(
      await renderAdvancedSettingsPage(
        session,
        subdomainPreview,
        subdomainPreviewFullDomain,
      ),
    );
  });

/**
 * Validate change password form data
 */
type ChangePasswordValidation =
  | { valid: true; currentPassword: string; newPassword: string }
  | { valid: false; error: string };

const validateChangePasswordForm = (
  form: FormParams,
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

    const success = await settings.updateUserPassword(
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

/** Type guard: check if a string is a valid payment provider */
const isPaymentProvider = (s: string): s is PaymentProviderType =>
  s === "stripe" || s === "square";

/**
 * Handle POST /admin/settings/payment-provider - owner only
 */
const handlePaymentProviderPost = settingsRoute(
  createSettingsHandler({
    formId: "settings-payment-provider",
    extract: (form) => form.getString("payment_provider"),
    validate: (v) =>
      v !== "none" && !isPaymentProvider(v) ? "Invalid payment provider" : null,
    save: (v) =>
      v === "none"
        ? settings.update.clearPaymentProvider()
        : settings.update.paymentProvider(v),
    log: (v) =>
      v === "none"
        ? "Payment provider disabled"
        : `Payment provider set to ${v}`,
    message: (v) =>
      v === "none"
        ? "Payment provider disabled"
        : `Payment provider set to ${v}`,
  }),
);

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
    if (!settings.stripe.hasKey) {
      return errorPage("Stripe Secret Key is required", 400, "settings-stripe");
    }
    // Empty with existing key = no change
    return redirect("/admin/settings", "Stripe settings unchanged", true, {
      formId: "settings-stripe",
    });
  }

  // Validate key format — must start with sk_test_ or sk_live_
  if (!detectStripeKeyMode(field.value)) {
    return errorPage(
      "Invalid Stripe key format. Keys must start with sk_test_ (test mode) or sk_live_ (live mode).",
      400,
      "settings-stripe",
    );
  }

  // Set up webhook endpoint automatically
  const webhookUrl = getWebhookUrl();
  const webhookResult = await setupWebhookEndpoint(
    field.value,
    webhookUrl,
    settings.stripe.webhookEndpointId,
  );

  if (!webhookResult.success) {
    return errorPage(
      `Failed to set up Stripe webhook: ${webhookResult.error}`,
      400,
      "settings-stripe",
    );
  }

  // Store the Stripe key and webhook config
  await settings.update.stripe.secretKey(field.value);
  await settings.update.stripe.webhookConfig(webhookResult);

  // Auto-set payment provider to stripe when key is configured
  await settings.update.paymentProvider("stripe");

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
  const locationId = form.getString("square_location_id");
  const sandbox = form.get("square_sandbox") === "on";

  if (!locationId) {
    return errorPage("Location ID is required", 400, "settings-square");
  }

  // Require a token when none is configured
  if (tokenField.action === "cleared" && !settings.square.hasToken) {
    return errorPage("Square Access Token is required", 400, "settings-square");
  }

  // Only update the token when a new value is provided
  if (tokenField.action === "provided") {
    await settings.update.square.accessToken(tokenField.value);
  }

  // Always allow updating non-secret fields
  await settings.update.square.locationId(locationId);
  await settings.update.square.sandbox(sandbox);

  // Auto-set payment provider to square when credentials are configured
  await settings.update.paymentProvider("square");

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
const handleAdminSquareWebhookPost = settingsRoute(
  secretFieldHandler({
    formId: "settings-square-webhook",
    field: "square_webhook_signature_key",
    label: "Square webhook signature key",
    required: true,
    save: (v) => settings.update.square.webhookSignatureKey(v),
  }),
);

/**
 * Handle POST /admin/settings/stripe/test - owner only
 */
const handleStripeTestPost = (request: Request): Promise<Response> =>
  withAuth(request, OWNER_FORM, async () => {
    const result = await testStripeConnection();
    return jsonResponse(result);
  });

/**
 * Handle POST /admin/settings/square/test - owner only
 */
const handleSquareTestPost = (request: Request): Promise<Response> =>
  withAuth(request, OWNER_FORM, async () => {
    const result = await testSquareConnection();
    return jsonResponse(result);
  });

/**
 * Handle POST /admin/settings/embed-hosts - owner only
 */
const handleEmbedHostsPost = settingsRoute(
  createSettingsHandler({
    formId: "settings-embed-hosts",
    extract: (form) => form.getString("embed_hosts"),
    validate: (v) => {
      if (v === "") return null;
      return validateEmbedHosts(v);
    },
    save: (v) =>
      settings.update.embedHosts(v === "" ? "" : parseEmbedHosts(v).join(", ")),
    log: (v) =>
      v === "" ? "Embed host restrictions removed" : "Allowed embed hosts updated",
    message: (v) =>
      v === "" ? "Embed host restrictions removed" : "Allowed embed hosts updated",
  }),
);

/**
 * Handle POST /admin/settings/terms - owner only
 */
const handleTermsPost = settingsRoute(
  createSettingsHandler({
    formId: "settings-terms",
    extract: (form) => {
      applyDemoOverrides(form, TERMS_DEMO_FIELDS);
      return form.getString("terms_and_conditions");
    },
    validate: (v) =>
      v.length > MAX_TEXTAREA_LENGTH
        ? `Terms must be ${MAX_TEXTAREA_LENGTH} characters or fewer (currently ${v.length})`
        : null,
    save: (v) => settings.update.terms(v),
    log: (v) =>
      v === ""
        ? "Terms and conditions removed"
        : "Terms and conditions updated",
    message: (v) =>
      v === ""
        ? "Terms and conditions removed"
        : "Terms and conditions updated",
  }),
);

/** Handle POST /admin/settings/country - owner only */
const handleCountryPost = settingsRoute(
  createSettingsHandler({
    formId: "settings-country",
    extract: (form) => form.getString("country").toUpperCase(),
    validate: (v) =>
      v === ""
        ? "Country is required"
        : !isValidCountry(v)
          ? "Please select a valid country"
          : null,
    save: (v) => settings.update.country(v),
    log: (v) => `Country set to ${v}`,
    message: () => "Country updated",
  }),
);

/** Handle POST /admin/settings/business-email - owner only */
const handleBusinessEmailPost = settingsRoute(
  clearableFieldHandler({
    formId: "settings-business-email",
    field: "business_email",
    label: "Business email",
    validate: (v) =>
      !isValidBusinessEmail(v)
        ? "Invalid email format. Please use format: name@domain.com"
        : null,
    save: (v) => updateBusinessEmail(v),
  }),
);

/** Handle POST /admin/settings/theme - owner only */
const handleThemePost = settingsRoute(
  createSettingsHandler({
    formId: "settings-theme",
    extract: (form) => form.getString("theme"),
    validate: (v) =>
      v !== "light" && v !== "dark" ? "Invalid theme selection" : null,
    save: (v) => settings.update.theme(v),
    log: (v) => `Theme set to ${v}`,
    message: (v) => `Theme updated to ${v}`,
  }),
);

/** Handle POST /admin/settings/show-public-site - owner only */
const handleShowPublicSitePost = settingsRoute(
  toggleHandler({
    formId: "settings-show-public-site",
    field: "show_public_site",
    label: "Public site",
    save: (v) => settings.update.showPublicSite(v),
  }),
);

/** Handle POST /admin/settings/show-public-api - owner only */
const handleShowPublicApiPost = advancedSettingsRoute(
  toggleHandler({
    formId: "settings-show-public-api",
    field: "show_public_api",
    label: "Public API",
    save: (v) => settings.update.showPublicApi(v),
    redirectTo: "/admin/settings-advanced",
  }),
);

/** Handle POST /admin/settings/booking-fee - owner only */
const handleBookingFeePost = settingsRoute(
  createSettingsHandler({
    formId: "settings-booking-fee",
    extract: (form) => Number.parseFloat(form.getString("booking_fee")),
    validate: (v) =>
      !Number.isFinite(v) || v < 0 || v > 10
        ? "Booking fee must be a number between 0 and 10"
        : null,
    save: (v) => settings.update.bookingFee(String(v)),
    log: (v) => `Booking fee set to ${v}%`,
    message: (v) => `Booking fee updated to ${v}%`,
  }),
);

/** Handle POST /admin/settings/header-image - owner only (multipart) */
const handleHeaderImagePost = (request: Request): Promise<Response> =>
  withAuth(request, OWNER_MULTIPART, async (_session, formData) => {
    if (!isStorageEnabled()) {
      return errorRedirect(
        "/admin/settings",
        "Image storage is not configured",
        "settings-header-image",
      );
    }

    const entry = formData.get("header_image");
    if (!(entry instanceof File) || entry.size === 0) {
      return errorRedirect(
        "/admin/settings",
        "No image file provided",
        "settings-header-image",
      );
    }

    const data = new Uint8Array(await entry.arrayBuffer());
    const validation = validateImage(data, entry.type);
    if (!validation.valid) {
      return errorRedirect(
        "/admin/settings",
        IMAGE_ERROR_MESSAGES[validation.error],
        "settings-header-image",
      );
    }

    // Delete old header image if one exists (best-effort, don't block new upload)
    const existingUrl = settings.headerImageUrl;
    if (existingUrl) {
      await tryDeleteImage(
        existingUrl,
        undefined,
        `header image: ${existingUrl}`,
      );
    }

    const [uploadResult] = await Promise.allSettled([
      uploadImage(data, validation.detectedType),
    ]);
    if (uploadResult.status === "fulfilled") {
      await settings.update.headerImageUrl(uploadResult.value);
      await logActivity("Header image uploaded");
      return redirect("/admin/settings", "Header image uploaded", true, {
        formId: "settings-header-image",
      });
    }
    const uploadDetail = `Header image upload failed: ${String(uploadResult.reason)}`;
    logError({ code: ErrorCode.STORAGE_UPLOAD, detail: uploadDetail });
    return redirect("/admin/settings", "Header image upload failed", false, {
      formId: "settings-header-image",
    });
  });

/** Handle POST /admin/settings/header-image/delete - owner only */
const handleHeaderImageDeletePost = settingsRoute(async (_form, _errorPage) => {
  if (!settings.headerImageUrl) {
    return errorRedirect(
      "/admin/settings",
      "No header image to remove",
      "settings-header-image",
    );
  }

  const [deleteResult] = await Promise.allSettled([
    deleteImage(settings.headerImageUrl),
  ]);
  if (deleteResult.status === "fulfilled") {
    await settings.update.headerImageUrl("");
    await logActivity("Header image removed");
    return redirect("/admin/settings", "Header image removed", true, {
      formId: "settings-header-image-delete",
    });
  }
  const deleteDetail = `Header image removal failed: ${String(deleteResult.reason)}`;
  logError({ code: ErrorCode.STORAGE_DELETE, detail: deleteDetail });
  return redirect("/admin/settings", "Header image removal failed", false, {
    formId: "settings-header-image-delete",
  });
});

/** Handle POST /admin/settings/email - owner only */
const handleEmailPost = advancedSettingsRoute(async (form, errorPage) => {
  const provider = form.getString("email_provider");
  const apiKeyField = processSecretField(form, "email_api_key");
  const fromAddress = form.getString("email_from_address");

  if (provider === "") {
    await settings.update.email.provider("");
    await settings.update.email.apiKey("");
    await settings.update.email.fromAddress("");
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

  await settings.update.email.provider(provider);
  if (apiKeyField.action === "provided")
    await settings.update.email.apiKey(apiKeyField.value);
  if (fromAddress) await settings.update.email.fromAddress(fromAddress);
  await logActivity(`Email provider set to ${provider}`);
  return redirect("/admin/settings-advanced", "Email settings updated", true, {
    formId: "settings-email",
  });
});

/** Handle POST /admin/settings/email/test - send test email to business email */
const handleEmailTestPost = advancedSettingsRoute(async (_form, errorPage) => {
  const config = await getEmailConfig();
  if (!config) return errorPage("Email not configured", 400, "settings-email");
  const businessEmail = settings.businessEmail;
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
    const subject = form.getString("subject");
    const html = form.getString("html");
    const text = form.getString("text");

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
      settings.update.email.template(type, "subject", subject.trim()),
      settings.update.email.template(type, "html", html.trim()),
      settings.update.email.template(type, "text", text.trim()),
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
  withAuth(request, OWNER_FORM, async (_session, form) => {
    const type = form.getString("type");
    const template = form.getString("template");
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

    const raw = form.getString("custom_domain").toLowerCase();

    if (raw === "") {
      await settings.update.customDomain("");
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

    const taskResult = await settings.withCurrentTask(
      "custom-domain",
      async () => {
        await settings.update.customDomain(raw);
        await logActivity(`Custom domain set to ${raw}`);

        // Attempt validation immediately after saving
        const result = await validateCustomDomain(raw);
        if (result.ok) {
          await settings.update.customDomainLastValidated();
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

    if (!taskResult.ok) {
      return errorPage(taskResult.error, 409, "settings-custom-domain");
    }
    return taskResult.value;
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

    const customDomain = settings.customDomain;
    if (!customDomain) {
      return errorPage(
        "No custom domain is configured",
        400,
        "settings-custom-domain-validate",
      );
    }

    const taskResult = await settings.withCurrentTask(
      "custom-domain-validate",
      async () => {
        const result = await validateCustomDomain(customDomain);
        if (!result.ok) {
          return errorPage(
            result.error,
            502,
            "settings-custom-domain-validate",
          );
        }

        await settings.update.customDomainLastValidated();
        await logActivity(`Custom domain validated: ${customDomain}`);
        return redirect(
          "/admin/settings-advanced",
          "Custom domain validated successfully",
          true,
          { formId: "settings-custom-domain-validate" },
        );
      },
    );

    if (!taskResult.ok) {
      return errorPage(
        taskResult.error,
        409,
        "settings-custom-domain-validate",
      );
    }
    return taskResult.value;
  },
);

/** Valid subdomain pattern: lowercase alphanumeric + hyphens, no leading/trailing hyphen */
const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const FORM_ID_HOST_SUBDOMAIN = "settings-host-subdomain";

/** Handle POST /admin/settings/host-subdomain - preview or register subdomain */
const handleHostSubdomainPost = advancedSettingsRoute(
  async (form, errorPage) => {
    if (!isBunnyDnsEnabled()) {
      return errorPage("Not configured", 400, FORM_ID_HOST_SUBDOMAIN);
    }
    if (settings.bunnySubdomain) {
      return errorPage(
        "Subdomain has already been set and cannot be changed",
        400,
        FORM_ID_HOST_SUBDOMAIN,
      );
    }

    const raw = form.getString("subdomain").toLowerCase().trim();
    if (!raw || !SUBDOMAIN_PATTERN.test(raw)) {
      return errorPage("Invalid subdomain format", 400, FORM_ID_HOST_SUBDOMAIN);
    }

    const save = form.getString("save");

    if (!save) {
      // Preview: check availability only
      const check = await checkSubdomainAvailable(raw);
      if (!check.ok) {
        return errorPage(check.error, 502, FORM_ID_HOST_SUBDOMAIN);
      }
      if (!check.available) {
        return errorPage(
          `Subdomain "${raw}" is already taken`,
          409,
          FORM_ID_HOST_SUBDOMAIN,
        );
      }
      return redirect(
        "/admin/settings-advanced",
        `${check.fullDomain} is available`,
        true,
        {
          formId: FORM_ID_HOST_SUBDOMAIN,
          result: `${raw}\n${check.fullDomain}`,
        },
      );
    }

    // Save: actually register (guarded by current_task)
    const taskResult = await settings.withCurrentTask(
      "host-subdomain",
      async () => {
        const result = await registerBunnySubdomain(raw);
        if (!result.ok) {
          return errorPage(result.error, 502, FORM_ID_HOST_SUBDOMAIN);
        }

        await settings.update.bunnySubdomain(result.fullDomain);
        await logActivity(`Host subdomain set to ${result.fullDomain}`);
        return redirect(
          "/admin/settings-advanced",
          `Subdomain registered: ${result.fullDomain}`,
          true,
          { formId: FORM_ID_HOST_SUBDOMAIN },
        );
      },
    );

    if (!taskResult.ok) {
      return errorPage(taskResult.error, 409, FORM_ID_HOST_SUBDOMAIN);
    }
    return taskResult.value;
  },
);

/**
 * Handle POST /admin/settings/apple-wallet - owner only
 */
const handleAppleWalletPost = advancedSettingsRoute(async (form, errorPage) => {
  const passTypeId = (form.get("apple_wallet_pass_type_id") as string).trim();
  const teamId = (form.get("apple_wallet_team_id") as string).trim();
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
      settings.update.appleWallet.passTypeId(""),
      settings.update.appleWallet.teamId(""),
      settings.update.appleWallet.signingCert(""),
      settings.update.appleWallet.signingKey(""),
      settings.update.appleWallet.wwdrCert(""),
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
  if (!settings.appleWallet.hasDbConfig) {
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

  await settings.update.appleWallet.passTypeId(passTypeId);
  await settings.update.appleWallet.teamId(teamId);
  if (certField.action === "provided")
    await settings.update.appleWallet.signingCert(certField.value);
  if (keyField.action === "provided")
    await settings.update.appleWallet.signingKey(keyField.value);
  if (wwdrField.action === "provided")
    await settings.update.appleWallet.wwdrCert(wwdrField.value);

  await logActivity("Apple Wallet configuration updated");
  return redirect(
    "/admin/settings-advanced",
    "Apple Wallet settings updated",
    true,
    { formId: "settings-apple-wallet" },
  );
});

/**
 * Handle POST /admin/settings/google-wallet - owner only
 */
const handleGoogleWalletPost = advancedSettingsRoute(
  async (form, errorPage) => {
    const issuerId = (form.get("google_wallet_issuer_id") as string).trim();
    const email = (
      form.get("google_wallet_service_account_email") as string
    ).trim();
    const keyField = processSecretField(
      form,
      "google_wallet_service_account_key",
    );

    // If everything is cleared, remove all settings
    if (!issuerId && !email && keyField.action === "cleared") {
      await Promise.all([
        settings.update.googleWallet.issuerId(""),
        settings.update.googleWallet.serviceAccountEmail(""),
        settings.update.googleWallet.serviceAccountKey(""),
      ]);
      await logActivity("Google Wallet configuration cleared");
      return redirect(
        "/admin/settings-advanced",
        "Google Wallet configuration cleared",
        true,
        { formId: "settings-google-wallet" },
      );
    }

    if (!issuerId) {
      return errorPage("Issuer ID is required", 400, "settings-google-wallet");
    }

    if (!email) {
      return errorPage(
        "Service account email is required",
        400,
        "settings-google-wallet",
      );
    }

    // For initial setup, require the private key
    if (!settings.googleWallet.hasDbConfig && keyField.action !== "provided") {
      return errorPage(
        "Service account private key is required",
        400,
        "settings-google-wallet",
      );
    }

    // Validate PEM format for newly provided key
    if (
      keyField.action === "provided" &&
      !(await isValidGooglePrivateKey(keyField.value))
    ) {
      return errorPage(
        "Service account private key is not a valid PEM private key",
        400,
        "settings-google-wallet",
      );
    }

    await settings.update.googleWallet.issuerId(issuerId);
    await settings.update.googleWallet.serviceAccountEmail(email);
    if (keyField.action === "provided")
      await settings.update.googleWallet.serviceAccountKey(keyField.value);

    await logActivity("Google Wallet configuration updated");
    return redirect(
      "/admin/settings-advanced",
      "Google Wallet settings updated",
      true,
      { formId: "settings-google-wallet" },
    );
  },
);

/**
 * Handle POST /admin/settings/reset-database - owner only
 */
const handleResetDatabasePost = advancedSettingsRoute(
  async (form, errorPage) => {
    const phraseError = validateResetPhrase(form);
    if (phraseError)
      return errorPage(phraseError, 400, "settings-reset-database");

    await logActivity("Database reset initiated");
    if (isStorageEnabled()) {
      await deleteAllEventStorageFiles(await getAllEvents());
    }
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
  "POST /admin/settings/square/test": handleSquareTestPost,
  "POST /admin/settings/embed-hosts": handleEmbedHostsPost,
  "POST /admin/settings/terms": handleTermsPost,
  "POST /admin/settings/country": handleCountryPost,
  "POST /admin/settings/business-email": handleBusinessEmailPost,
  "POST /admin/settings/theme": handleThemePost,
  "POST /admin/settings/show-public-site": handleShowPublicSitePost,
  "POST /admin/settings/show-public-api": handleShowPublicApiPost,
  "POST /admin/settings/booking-fee": handleBookingFeePost,
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
  "POST /admin/settings/host-subdomain": handleHostSubdomainPost,
  "POST /admin/settings/apple-wallet": handleAppleWalletPost,
  "POST /admin/settings/google-wallet": handleGoogleWalletPost,
  "POST /admin/settings/reset-database": handleResetDatabasePost,
});
