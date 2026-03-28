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
import type { Theme } from "#lib/types.ts";
import { validateResetPhrase } from "#routes/admin/database-reset.ts";
import {
  advancedSettingsRoute,
  processSecretField,
  type SecretFieldResult,
  settingsClearable,
  settingsHandler,
  settingsRoute,
  settingsSecret,
  settingsToggle,
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

export type { SecretFieldResult } from "#routes/admin/settings-helpers.ts";
export { processSecretField } from "#routes/admin/settings-helpers.ts";

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
const handlePaymentProviderPost = settingsHandler({
  formId: "settings-payment-provider",
  label: "Payment provider",
  extract: (form) => form.getString("payment_provider"),
  validate: (v) =>
    v !== "none" && !isPaymentProvider(v) ? "Invalid payment provider" : null,
  save: (v) =>
    v === "none"
      ? settings.update.clearPaymentProvider()
      : settings.update.paymentProvider(v as PaymentProviderType),
  log: (v) =>
    v === "none"
      ? "Payment provider disabled"
      : `Payment provider set to ${v}`,
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
    if (!settings.stripe.hasKey) {
      return errorPage("Stripe Secret Key is required", 400, "settings-stripe");
    }
    return redirect("/admin/settings", "Stripe settings unchanged", true, {
      formId: "settings-stripe",
    });
  }

  if (!detectStripeKeyMode(field.value)) {
    return errorPage(
      "Invalid Stripe key format. Keys must start with sk_test_ (test mode) or sk_live_ (live mode).",
      400,
      "settings-stripe",
    );
  }

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

  await settings.update.stripe.secretKey(field.value);
  await settings.update.stripe.webhookConfig(webhookResult);
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
type SquareFormData = {
  token: SecretFieldResult;
  locationId: string;
  sandbox: boolean;
};

const handleAdminSquarePost = settingsHandler<SquareFormData>({
  formId: "settings-square",
  label: "Square credentials",
  extract: (form) => ({
    token: processSecretField(form, "square_access_token"),
    locationId: form.getString("square_location_id"),
    sandbox: form.get("square_sandbox") === "on",
  }),
  validate: ({ token, locationId }) => {
    if (isDemoMode()) return "Cannot configure Square in demo mode";
    if (!locationId) return "Location ID is required";
    if (token.action === "cleared" && !settings.square.hasToken) {
      return "Square Access Token is required";
    }
    return null;
  },
  save: async ({ token, locationId, sandbox }) => {
    if (token.action === "provided") {
      await settings.update.square.accessToken(token.value);
    }
    await settings.update.square.locationId(locationId);
    await settings.update.square.sandbox(sandbox);
    await settings.update.paymentProvider("square");
  },
});

/**
 * Handle POST /admin/settings/square-webhook - owner only
 */
const handleAdminSquareWebhookPost = settingsSecret({
  formId: "settings-square-webhook",
  field: "square_webhook_signature_key",
  label: "Square webhook signature key",
  required: true,
  save: (v) => settings.update.square.webhookSignatureKey(v),
});

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
const handleEmbedHostsPost = settingsHandler({
  formId: "settings-embed-hosts",
  label: "Embed host restrictions",
  extract: (form) => form.getString("embed_hosts"),
  validate: (v) => {
    if (v === "") return null;
    return validateEmbedHosts(v);
  },
  save: (v) =>
    settings.update.embedHosts(v === "" ? "" : parseEmbedHosts(v).join(", ")),
  log: (v) =>
    v === ""
      ? "Embed host restrictions removed"
      : "Allowed embed hosts updated",
});

/**
 * Handle POST /admin/settings/terms - owner only
 */
const handleTermsPost = settingsHandler({
  formId: "settings-terms",
  label: "Terms and conditions",
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
    v === "" ? "Terms and conditions removed" : "Terms and conditions updated",
});

/** Handle POST /admin/settings/country - owner only */
const handleCountryPost = settingsHandler({
  formId: "settings-country",
  label: "Country",
  extract: (form) => form.getString("country").toUpperCase(),
  validate: (v) =>
    v === ""
      ? "Country is required"
      : !isValidCountry(v)
        ? "Please select a valid country"
        : null,
  save: (v) => settings.update.country(v),
  log: (v) => `Country set to ${v}`,
});

/** Handle POST /admin/settings/business-email - owner only */
const handleBusinessEmailPost = settingsClearable({
  formId: "settings-business-email",
  field: "business_email",
  label: "Business email",
  validate: (v) =>
    !isValidBusinessEmail(v)
      ? "Invalid email format. Please use format: name@domain.com"
      : null,
  save: (v) => updateBusinessEmail(v),
});

/** Handle POST /admin/settings/theme - owner only */
const handleThemePost = settingsHandler({
  formId: "settings-theme",
  label: "Theme",
  extract: (form) => form.getString("theme"),
  validate: (v) =>
    v !== "light" && v !== "dark" ? "Invalid theme selection" : null,
  save: (v) => settings.update.theme(v as Theme),
  log: (v) => `Theme set to ${v}`,
});

/** Handle POST /admin/settings/show-public-site - owner only */
const handleShowPublicSitePost = settingsToggle({
  formId: "settings-show-public-site",
  field: "show_public_site",
  label: "Public site",
  save: (v) => settings.update.showPublicSite(v),
});

/** Handle POST /admin/settings/show-public-api - owner only */
const handleShowPublicApiPost = settingsToggle({
  formId: "settings-show-public-api",
  field: "show_public_api",
  label: "Public API",
  advanced: true,
  save: (v) => settings.update.showPublicApi(v),
});

/** Handle POST /admin/settings/booking-fee - owner only */
const handleBookingFeePost = settingsHandler({
  formId: "settings-booking-fee",
  label: "Booking fee",
  extract: (form) => Number.parseFloat(form.getString("booking_fee")),
  validate: (v) =>
    !Number.isFinite(v) || v < 0 || v > 10
      ? "Booking fee must be a number between 0 and 10"
      : null,
  save: (v) => settings.update.bookingFee(String(v)),
  log: (v) => `Booking fee set to ${v}%`,
});

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
type EmailFormData = {
  provider: string;
  apiKey: SecretFieldResult;
  fromAddress: string;
};

const handleEmailPost = settingsHandler<EmailFormData>({
  formId: "settings-email",
  label: "Email settings",
  advanced: true,
  extract: (form) => ({
    provider: form.getString("email_provider"),
    apiKey: processSecretField(form, "email_api_key"),
    fromAddress: form.getString("email_from_address"),
  }),
  validate: ({ provider, fromAddress }) => {
    if (provider === "") return null;
    if (!isEmailProvider(provider)) return "Invalid email provider";
    if (fromAddress && !isValidBusinessEmail(fromAddress)) {
      return "Invalid from-address format. Please use format: name@domain.com";
    }
    return null;
  },
  save: async ({ provider, apiKey, fromAddress }) => {
    if (provider === "") {
      await settings.update.email.provider("");
      await settings.update.email.apiKey("");
      await settings.update.email.fromAddress("");
      return;
    }
    await settings.update.email.provider(provider);
    if (apiKey.action === "provided")
      await settings.update.email.apiKey(apiKey.value);
    if (fromAddress) await settings.update.email.fromAddress(fromAddress);
  },
  log: ({ provider }) =>
    provider === "" ? "Email provider disabled" : "Email settings updated",
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
type TemplateFormData = { subject: string; html: string; text: string };

const validateTemplateFields = ({
  subject,
  html,
  text,
}: TemplateFormData): string | null => {
  for (const [name, value] of [
    ["subject", subject],
    ["html", html],
    ["text", text],
  ] as const) {
    if (value.length > MAX_EMAIL_TEMPLATE_LENGTH) {
      return `Template ${name} exceeds maximum length of ${MAX_EMAIL_TEMPLATE_LENGTH} characters`;
    }
  }
  for (const [name, value] of [
    ["subject", subject],
    ["html", html],
    ["text", text],
  ] as const) {
    if (value) {
      const error = validateTemplate(value);
      if (error) return `Invalid template syntax in ${name}: ${error}`;
    }
  }
  return null;
};

const handleEmailTemplatePost = (type: EmailTemplateType) => {
  const label = type === "confirmation" ? "Confirmation" : "Admin notification";
  return settingsHandler<TemplateFormData>({
    formId: `settings-email-tpl-${type}`,
    label: `${label} email template`,
    advanced: true,
    extract: (form) => ({
      subject: form.getString("subject"),
      html: form.getString("html"),
      text: form.getString("text"),
    }),
    validate: validateTemplateFields,
    save: async ({ subject, html, text }) => {
      await Promise.all([
        settings.update.email.template(type, "subject", subject.trim()),
        settings.update.email.template(type, "html", html.trim()),
        settings.update.email.template(type, "text", text.trim()),
      ]);
    },
  });
};

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
type AppleWalletFormData = {
  passTypeId: string;
  teamId: string;
  cert: SecretFieldResult;
  key: SecretFieldResult;
  wwdr: SecretFieldResult;
};

const isAllCleared = (d: AppleWalletFormData): boolean =>
  !d.passTypeId &&
  !d.teamId &&
  d.cert.action === "cleared" &&
  d.key.action === "cleared" &&
  d.wwdr.action === "cleared";

const handleAppleWalletPost = settingsHandler<AppleWalletFormData>({
  formId: "settings-apple-wallet",
  label: "Apple Wallet configuration",
  advanced: true,
  extract: (form) => ({
    passTypeId: form.getString("apple_wallet_pass_type_id"),
    teamId: form.getString("apple_wallet_team_id"),
    cert: processSecretField(form, "apple_wallet_signing_cert"),
    key: processSecretField(form, "apple_wallet_signing_key"),
    wwdr: processSecretField(form, "apple_wallet_wwdr_cert"),
  }),
  validate: (d) => {
    if (isAllCleared(d)) return null;
    if (!d.passTypeId) return "Pass Type ID is required";
    if (!d.teamId) return "Team ID is required";
    if (!settings.appleWallet.hasDbConfig) {
      if (d.cert.action !== "provided")
        return "Signing certificate is required";
      if (d.key.action !== "provided") return "Signing private key is required";
      if (d.wwdr.action !== "provided") return "WWDR certificate is required";
    }
    if (d.cert.action === "provided" && !isValidPemCertificate(d.cert.value)) {
      return "Signing certificate is not a valid PEM certificate";
    }
    if (d.key.action === "provided" && !isValidPemPrivateKey(d.key.value)) {
      return "Signing private key is not a valid PEM private key";
    }
    if (d.wwdr.action === "provided" && !isValidPemCertificate(d.wwdr.value)) {
      return "WWDR certificate is not a valid PEM certificate";
    }
    return null;
  },
  save: async (d) => {
    if (isAllCleared(d)) {
      await Promise.all([
        settings.update.appleWallet.passTypeId(""),
        settings.update.appleWallet.teamId(""),
        settings.update.appleWallet.signingCert(""),
        settings.update.appleWallet.signingKey(""),
        settings.update.appleWallet.wwdrCert(""),
      ]);
      return;
    }
    await settings.update.appleWallet.passTypeId(d.passTypeId);
    await settings.update.appleWallet.teamId(d.teamId);
    if (d.cert.action === "provided")
      await settings.update.appleWallet.signingCert(d.cert.value);
    if (d.key.action === "provided")
      await settings.update.appleWallet.signingKey(d.key.value);
    if (d.wwdr.action === "provided")
      await settings.update.appleWallet.wwdrCert(d.wwdr.value);
  },
  log: (d) =>
    isAllCleared(d)
      ? "Apple Wallet configuration cleared"
      : "Apple Wallet configuration updated",
});

/**
 * Handle POST /admin/settings/google-wallet - owner only
 */
type GoogleWalletFormData = {
  issuerId: string;
  email: string;
  key: SecretFieldResult;
};

const isGoogleWalletCleared = (d: GoogleWalletFormData): boolean =>
  !d.issuerId && !d.email && d.key.action === "cleared";

const handleGoogleWalletPost = settingsHandler<GoogleWalletFormData>({
  formId: "settings-google-wallet",
  label: "Google Wallet configuration",
  advanced: true,
  extract: (form) => ({
    issuerId: form.getString("google_wallet_issuer_id"),
    email: form.getString("google_wallet_service_account_email"),
    key: processSecretField(form, "google_wallet_service_account_key"),
  }),
  validate: async (d) => {
    if (isGoogleWalletCleared(d)) return null;
    if (!d.issuerId) return "Issuer ID is required";
    if (!d.email) return "Service account email is required";
    if (!settings.googleWallet.hasDbConfig && d.key.action !== "provided") {
      return "Service account private key is required";
    }
    if (
      d.key.action === "provided" &&
      !(await isValidGooglePrivateKey(d.key.value))
    ) {
      return "Service account private key is not a valid PEM private key";
    }
    return null;
  },
  save: async (d) => {
    if (isGoogleWalletCleared(d)) {
      await Promise.all([
        settings.update.googleWallet.issuerId(""),
        settings.update.googleWallet.serviceAccountEmail(""),
        settings.update.googleWallet.serviceAccountKey(""),
      ]);
      return;
    }
    await settings.update.googleWallet.issuerId(d.issuerId);
    await settings.update.googleWallet.serviceAccountEmail(d.email);
    if (d.key.action === "provided")
      await settings.update.googleWallet.serviceAccountKey(d.key.value);
  },
  log: (d) =>
    isGoogleWalletCleared(d)
      ? "Google Wallet configuration cleared"
      : "Google Wallet configuration updated",
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
