/**
 * Admin settings routes - password, payment provider, and key configuration
 * Owner-only access enforced via requireOwnerOr / withAuth
 */

import { demoResetForm } from "#routes/admin/database-reset.ts";
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
import {
  type AuthSession,
  OWNER_FORM,
  OWNER_MULTIPART,
  ownerPage,
  withAuth,
} from "#routes/auth.ts";
import { errorRedirect, jsonResponse } from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import {
  isValidPemCertificate,
  isValidPemPrivateKey,
} from "#shared/apple-wallet.ts";
import {
  checkSubdomainAvailable,
  getCdnHostname,
  registerBunnySubdomain,
  validateCustomDomain,
} from "#shared/bunny-cdn.ts";
import {
  isValidBusinessEmail,
  updateBusinessEmail,
} from "#shared/business-email.ts";
import { validateColumnTemplate } from "#shared/column-order.ts";
import { ATTENDEE_TABLE_COLUMNS } from "#shared/columns/attendee-columns.ts";
import { EVENT_TABLE_COLUMNS } from "#shared/columns/event-columns.ts";
import {
  getBunnyDnsSubdomainSuffix,
  getEffectiveDomain,
  isBunnyCdnEnabled,
  isBunnyDnsEnabled,
} from "#shared/config.ts";
import { clearSessionCookie } from "#shared/cookies.ts";
import { isValidCountry } from "#shared/countries.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { getAllEvents } from "#shared/db/events.ts";
import { resetDatabase } from "#shared/db/migrations.ts";
import {
  type EmailTemplateType,
  MAX_EMAIL_TEMPLATE_LENGTH,
  settings,
} from "#shared/db/settings.ts";
import { getUserById, verifyUserPassword } from "#shared/db/users.ts";
import {
  applyDemoOverrides,
  isDemoMode,
  TERMS_DEMO_FIELDS,
} from "#shared/demo.ts";
import {
  EMAIL_PROVIDER_LABELS,
  getEmailConfig,
  getHostEmailConfig,
  isEmailProvider,
  sendTestEmail,
} from "#shared/email.ts";
import {
  buildTemplateData,
  renderTemplate,
  validateTemplate,
} from "#shared/email-renderer.ts";
import {
  DOMAIN_PATTERN,
  parseEmbedHosts,
  validateEmbedHosts,
} from "#shared/embed-hosts.ts";
import { getFlash } from "#shared/flash-context.ts";
import type { FormParams } from "#shared/form-data.ts";
import { validateForm } from "#shared/forms.tsx";
import { isValidGooglePrivateKey } from "#shared/google-wallet.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import type { PaymentProviderType } from "#shared/payments.ts";
import { fail, ok } from "#shared/response.ts";
import { testSquareConnection } from "#shared/square.ts";
import {
  deleteAllEventStorageFiles,
  deleteFile,
  IMAGE_ERROR_MESSAGES,
  isStorageEnabled,
  tryDeleteFile,
  uploadImage,
  validateImage,
} from "#shared/storage.ts";
import {
  detectStripeKeyMode,
  setupWebhookEndpoint,
  testStripeConnection,
} from "#shared/stripe.ts";
import type { Theme } from "#shared/types.ts";
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
    bookingFee: settings.bookingFee,
    businessEmail: settings.businessEmail,
    country: settings.country,
    embedHosts: settings.embedHosts,
    headerImageUrl: settings.headerImageUrl,
    paymentProvider: settings.paymentProvider ?? "",
    showPublicSite: settings.showPublicSite,
    squareSandbox: settings.square.sandbox,
    squareTokenConfigured: settings.square.hasToken,
    squareWebhookConfigured: settings.square.webhookSignatureKey !== "",
    storageEnabled: isStorageEnabled(),
    stripeKeyConfigured: settings.stripe.hasKey,
    stripeKeyMode: settings.stripe.keyMode,
    termsAndConditions: settings.terms,
    theme: settings.theme,
    webhookUrl: getWebhookUrl(),
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
    adminTemplates,
    appleWalletConfigured: settings.appleWallet.hasDbConfig,
    appleWalletPassTypeId: settings.appleWallet.passTypeId,
    appleWalletTeamId: settings.appleWallet.teamId,
    attendeeColumnOrder: settings.attendeeColumnOrder,
    bunnyCdnEnabled: bunnyCdnConfigured,
    bunnyDnsEnabled,
    bunnyDnsSubdomainSuffix: bunnyDnsEnabled
      ? getBunnyDnsSubdomainSuffix()
      : "",
    bunnySubdomain: settings.bunnySubdomain,
    businessEmail: settings.businessEmail,
    cdnHostname: cdnResult?.ok ? cdnResult.hostname : "",
    confirmationTemplates,
    customDomain: (bunnyCdnConfigured ? settings.customDomain : null) ?? "",
    customDomainLastValidated:
      (bunnyCdnConfigured ? settings.customDomainLastValidated : null) ?? "",
    emailApiKeyConfigured: settings.email.hasApiKey,
    emailFromAddress: settings.email.fromAddress,
    emailProvider: settings.email.provider,
    eventColumnOrder: settings.eventColumnOrder,
    googleWalletConfigured: settings.googleWallet.hasDbConfig,
    googleWalletIssuerId: settings.googleWallet.issuerId,
    googleWalletServiceAccountEmail: settings.googleWallet.serviceAccountEmail,
    hostAppleWalletLabel: (() => {
      const hostConfig = settings.appleWallet.hostConfig;
      if (!hostConfig) return "";
      return `Host env (${hostConfig.passTypeId})`;
    })(),
    hostEmailLabel: (() => {
      const hostConfig = getHostEmailConfig();
      if (!hostConfig) return "";
      const label = EMAIL_PROVIDER_LABELS[hostConfig.provider];
      return `Host ${label} (${hostConfig.fromAddress})`;
    })(),
    hostGoogleWalletLabel: (() => {
      const hostConfig = settings.googleWallet.hostConfig;
      if (!hostConfig) return "";
      return `Host env (${hostConfig.issuerId})`;
    })(),
    showPublicApi: settings.showPublicApi,
    subdomainPreview,
    subdomainPreviewFullDomain,
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
const handleAdminSettingsGet: TypedRouteHandler<"GET /admin/settings"> =
  ownerPage((session) => renderSettingsPage(session));

/**
 * Handle GET /admin/settings-advanced - owner only
 */
const handleAdminSettingsAdvancedGet: TypedRouteHandler<"GET /admin/settings-advanced"> =
  ownerPage(async (session) => {
    const flash = getFlash();
    const [subdomainPreview = "", subdomainPreviewFullDomain = ""] =
      flash.result?.split("\n") ?? [];
    return await renderAdvancedSettingsPage(
      session,
      subdomainPreview,
      subdomainPreviewFullDomain,
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
      error: "New password must be at least 8 characters",
      valid: false,
    };
  }
  if (new_password !== new_password_confirm) {
    return { error: "New passwords do not match", valid: false };
  }

  return {
    currentPassword: current_password,
    newPassword: new_password,
    valid: true,
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
    return ok("/admin", "Password changed — please log in again", {
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
  extract: (form) => form.getString("payment_provider"),
  formId: "settings-payment-provider",
  label: "Payment provider",
  log: (v) =>
    v === "none" ? "Payment provider disabled" : `Payment provider set to ${v}`,
  save: (v) =>
    v === "none"
      ? settings.update.setPaymentProviderNone()
      : settings.update.paymentProvider(v as PaymentProviderType),
  validate: (v) =>
    v !== "none" && !isPaymentProvider(v) ? "Invalid payment provider" : null,
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
    return ok("/admin/settings", "Stripe settings unchanged", {
      formId: "settings-stripe",
    });
  }

  if (field.action === "cleared") {
    if (!settings.stripe.hasKey) {
      return errorPage("Stripe Secret Key is required", 400, "settings-stripe");
    }
    return ok("/admin/settings", "Stripe settings unchanged", {
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
  return ok(
    "/admin/settings",
    "Stripe key updated and webhook configured successfully",
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
  extract: (form) => ({
    locationId: form.getString("square_location_id"),
    sandbox: form.get("square_sandbox") === "on",
    token: processSecretField(form, "square_access_token"),
  }),
  formId: "settings-square",
  label: "Square credentials",
  save: async ({ token, locationId, sandbox }) => {
    if (token.action === "provided") {
      await settings.update.square.accessToken(token.value);
    }
    await settings.update.square.locationId(locationId);
    await settings.update.square.sandbox(sandbox);
    await settings.update.paymentProvider("square");
  },
  validate: ({ token, locationId }) => {
    if (isDemoMode()) return "Cannot configure Square in demo mode";
    if (!locationId) return "Location ID is required";
    if (token.action === "cleared" && !settings.square.hasToken) {
      return "Square Access Token is required";
    }
    return null;
  },
});

/**
 * Handle POST /admin/settings/square-webhook - owner only
 */
const handleAdminSquareWebhookPost = settingsSecret({
  field: "square_webhook_signature_key",
  formId: "settings-square-webhook",
  label: "Square webhook signature key",
  required: true,
  save: (v) => settings.update.square.webhookSignatureKey(v),
});

/** Owner auth POST that runs a test function and returns JSON */
const testRoute =
  (testFn: () => Promise<unknown>) =>
  (request: Request): Promise<Response> =>
    withAuth(request, OWNER_FORM, async () => jsonResponse(await testFn()));

const handleStripeTestPost = testRoute(testStripeConnection);
const handleSquareTestPost = testRoute(testSquareConnection);

/**
 * Handle POST /admin/settings/embed-hosts - owner only
 */
const handleEmbedHostsPost = settingsHandler({
  extract: (form) => form.getString("embed_hosts"),
  formId: "settings-embed-hosts",
  label: "Embed host restrictions",
  log: (v) =>
    v === ""
      ? "Embed host restrictions removed"
      : "Allowed embed hosts updated",
  save: (v) =>
    settings.update.embedHosts(v === "" ? "" : parseEmbedHosts(v).join(", ")),
  validate: (v) => {
    if (v === "") return null;
    return validateEmbedHosts(v);
  },
});

/**
 * Handle POST /admin/settings/terms - owner only
 */
const handleTermsPost = settingsHandler({
  extract: (form) => {
    applyDemoOverrides(form, TERMS_DEMO_FIELDS);
    return form.getString("terms_and_conditions");
  },
  formId: "settings-terms",
  label: "Terms and conditions",
  log: (v) =>
    v === "" ? "Terms and conditions removed" : "Terms and conditions updated",
  save: (v) => settings.update.terms(v),
  validate: (v) =>
    v.length > MAX_TEXTAREA_LENGTH
      ? `Terms must be ${MAX_TEXTAREA_LENGTH} characters or fewer (currently ${v.length})`
      : null,
});

/** Handle POST /admin/settings/country - owner only */
const handleCountryPost = settingsHandler({
  extract: (form) => form.getString("country").toUpperCase(),
  formId: "settings-country",
  label: "Country",
  log: (v) => `Country set to ${v}`,
  save: (v) => settings.update.country(v),
  validate: (v) =>
    v === ""
      ? "Country is required"
      : !isValidCountry(v)
        ? "Please select a valid country"
        : null,
});

/** Handle POST /admin/settings/business-email - owner only */
const handleBusinessEmailPost = settingsClearable({
  field: "business_email",
  formId: "settings-business-email",
  label: "Business email",
  save: (v) => updateBusinessEmail(v),
  validate: (v) =>
    !isValidBusinessEmail(v)
      ? "Invalid email format. Please use format: name@domain.com"
      : null,
});

/** Handle POST /admin/settings/theme - owner only */
const handleThemePost = settingsHandler({
  extract: (form) => form.getString("theme"),
  formId: "settings-theme",
  label: "Theme",
  log: (v) => `Theme set to ${v}`,
  save: (v) => settings.update.theme(v as Theme),
  validate: (v) =>
    v !== "light" && v !== "dark" ? "Invalid theme selection" : null,
});

/** Handle POST /admin/settings/show-public-site - owner only */
const handleShowPublicSitePost = settingsToggle({
  field: "show_public_site",
  formId: "settings-show-public-site",
  label: "Public site",
  save: (v) => settings.update.showPublicSite(v),
});

/** Handle POST /admin/settings/show-public-api - owner only */
const handleShowPublicApiPost = settingsToggle({
  advanced: true,
  field: "show_public_api",
  formId: "settings-show-public-api",
  label: "Public API",
  save: (v) => settings.update.showPublicApi(v),
});

/** Handle POST /admin/settings/booking-fee - owner only */
const handleBookingFeePost = settingsHandler({
  extract: (form) => Number.parseFloat(form.getString("booking_fee")),
  formId: "settings-booking-fee",
  label: "Booking fee",
  log: (v) => `Booking fee set to ${v}%`,
  save: (v) => settings.update.bookingFee(String(v)),
  validate: (v) =>
    !Number.isFinite(v) || v < 0 || v > 10
      ? "Booking fee must be a number between 0 and 10"
      : null,
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
      await tryDeleteFile(
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
      return ok("/admin/settings", "Header image uploaded", {
        formId: "settings-header-image",
      });
    }
    const uploadDetail = `Header image upload failed: ${String(
      uploadResult.reason,
    )}`;
    logError({ code: ErrorCode.STORAGE_UPLOAD, detail: uploadDetail });
    return fail("/admin/settings", "Header image upload failed", {
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
    deleteFile(settings.headerImageUrl),
  ]);
  if (deleteResult.status === "fulfilled") {
    await settings.update.headerImageUrl("");
    await logActivity("Header image removed");
    return ok("/admin/settings", "Header image removed", {
      formId: "settings-header-image-delete",
    });
  }
  const deleteDetail = `Header image removal failed: ${String(
    deleteResult.reason,
  )}`;
  logError({ code: ErrorCode.STORAGE_DELETE, detail: deleteDetail });
  return fail("/admin/settings", "Header image removal failed", {
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
  advanced: true,
  extract: (form) => ({
    apiKey: processSecretField(form, "email_api_key"),
    fromAddress: form.getString("email_from_address"),
    provider: form.getString("email_provider"),
  }),
  formId: "settings-email",
  label: "Email settings",
  log: ({ provider }) =>
    provider === "" ? "Email provider disabled" : "Email settings updated",
  save: async ({ provider, apiKey, fromAddress }) => {
    if (provider === "") {
      await settings.update.email.provider("");
      await settings.update.email.apiKey("");
      await settings.update.email.fromAddress("");
      return;
    }
    await settings.update.email.provider(provider);
    if (apiKey.action === "provided") {
      await settings.update.email.apiKey(apiKey.value);
    }
    if (fromAddress) await settings.update.email.fromAddress(fromAddress);
  },
  validate: ({ provider, fromAddress }) => {
    if (provider === "") return null;
    if (!isEmailProvider(provider)) return "Invalid email provider";
    if (fromAddress && !isValidBusinessEmail(fromAddress)) {
      return "Invalid from-address format. Please use format: name@domain.com";
    }
    return null;
  },
});

/** Handle POST /admin/settings/email/test - send test email to business email */
const handleEmailTestPost = advancedSettingsRoute(async (_form, errorPage) => {
  const config = await getEmailConfig();
  if (!config) return errorPage("Email not configured", 400, "settings-email");
  const businessEmail = settings.businessEmail;
  if (!businessEmail) {
    return errorPage("No business email set", 400, "settings-email-test");
  }
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
  return ok("/admin/settings-advanced", `Test email sent (status ${status})`, {
    formId: "settings-email-test",
  });
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
    advanced: true,
    extract: (form) => ({
      html: form.getString("html"),
      subject: form.getString("subject"),
      text: form.getString("text"),
    }),
    formId: `settings-email-tpl-${type}`,
    label: `${label} email template`,
    save: async ({ subject, html, text }) => {
      await Promise.all([
        settings.update.email.template(type, "subject", subject.trim()),
        settings.update.email.template(type, "html", html.trim()),
        settings.update.email.template(type, "text", text.trim()),
      ]);
    },
    validate: validateTemplateFields,
  });
};

/** Sample booking data used for email template previews */
const PREVIEW_BOOKINGS = [
  {
    attendee: {
      address: "123 High Street, London",
      date: null,
      email: "jane@example.com",
      id: 1,
      name: "Jane Smith",
      payment_id: "pi_sample",
      phone: "+44 7700 900000",
      price_paid: "5000",
      quantity: 2,
      special_instructions: "Wheelchair access please",
      ticket_token: "SAMPLE123",
    },
    event: {
      assign_built_site: false,
      attendee_count: 42,
      can_pay_more: false,
      date: "2026-07-15T19:00:00Z",
      id: 1,
      location: "Town Hall",
      max_attendees: 100,
      name: "Summer Concert",
      purchase_only: false,
      slug: "summer-concert",
      unit_price: 2500,
      webhook_url: "",
    },
  },
  {
    attendee: {
      address: "123 High Street, London",
      date: "2026-04-15",
      email: "jane@example.com",
      id: 2,
      name: "Jane Smith",
      payment_id: "",
      phone: "+44 7700 900000",
      price_paid: "0",
      quantity: 1,
      special_instructions: "Wheelchair access please",
      ticket_token: "SAMPLE456",
    },
    event: {
      assign_built_site: false,
      attendee_count: 8,
      can_pay_more: false,
      date: "",
      id: 2,
      location: "",
      max_attendees: 20,
      name: "Workshop",
      purchase_only: false,
      slug: "workshop",
      unit_price: 0,
      webhook_url: "",
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
      return jsonResponse({ format, rendered });
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
      return ok("/admin/settings-advanced", "Custom domain cleared", {
        formId: "settings-custom-domain",
      });
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
          return ok(
            "/admin/settings-advanced",
            "Custom domain saved and validated",
            {
              formId: "settings-custom-domain",
            },
          );
        }

        return fail(
          "/admin/settings-advanced",
          `Custom domain saved but validation failed: ${result.error}`,
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
        return ok(
          "/admin/settings-advanced",
          "Custom domain validated successfully",
          {
            formId: "settings-custom-domain-validate",
          },
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
      return ok(
        "/admin/settings-advanced",
        `${check.fullDomain} is available`,
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
        return ok(
          "/admin/settings-advanced",
          `Subdomain registered: ${result.fullDomain}`,
          {
            formId: FORM_ID_HOST_SUBDOMAIN,
          },
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
  advanced: true,
  extract: (form) => ({
    cert: processSecretField(form, "apple_wallet_signing_cert"),
    key: processSecretField(form, "apple_wallet_signing_key"),
    passTypeId: form.getString("apple_wallet_pass_type_id"),
    teamId: form.getString("apple_wallet_team_id"),
    wwdr: processSecretField(form, "apple_wallet_wwdr_cert"),
  }),
  formId: "settings-apple-wallet",
  label: "Apple Wallet configuration",
  log: (d) =>
    isAllCleared(d)
      ? "Apple Wallet configuration cleared"
      : "Apple Wallet configuration updated",
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
    if (d.cert.action === "provided") {
      await settings.update.appleWallet.signingCert(d.cert.value);
    }
    if (d.key.action === "provided") {
      await settings.update.appleWallet.signingKey(d.key.value);
    }
    if (d.wwdr.action === "provided") {
      await settings.update.appleWallet.wwdrCert(d.wwdr.value);
    }
  },
  validate: (d) => {
    if (isAllCleared(d)) return null;
    if (!d.passTypeId) return "Pass Type ID is required";
    if (!d.teamId) return "Team ID is required";
    if (!settings.appleWallet.hasDbConfig) {
      const requiredError = validateAppleWalletRequiredSecrets(d);
      if (requiredError) return requiredError;
    }
    return validateAppleWalletPemFields(d);
  },
});

/** Ensure required secrets are provided when no DB config exists */
const validateAppleWalletRequiredSecrets = (
  d: AppleWalletFormData,
): string | null => {
  if (d.cert.action !== "provided") return "Signing certificate is required";
  if (d.key.action !== "provided") return "Signing private key is required";
  if (d.wwdr.action !== "provided") return "WWDR certificate is required";
  return null;
};

/** Validate PEM structure of provided Apple Wallet secret fields */
const validateAppleWalletPemFields = (
  d: AppleWalletFormData,
): string | null => {
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
};

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
  advanced: true,
  extract: (form) => ({
    email: form.getString("google_wallet_service_account_email"),
    issuerId: form.getString("google_wallet_issuer_id"),
    key: processSecretField(form, "google_wallet_service_account_key"),
  }),
  formId: "settings-google-wallet",
  label: "Google Wallet configuration",
  log: (d) =>
    isGoogleWalletCleared(d)
      ? "Google Wallet configuration cleared"
      : "Google Wallet configuration updated",
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
    if (d.key.action === "provided") {
      await settings.update.googleWallet.serviceAccountKey(d.key.value);
    }
  },
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
});

/**
 * Handle POST /admin/settings/reset-database - owner only
 */
const handleResetDatabasePost = advancedSettingsRoute(
  async (form, errorPage) => {
    const phraseResult = demoResetForm.validate(form);
    if (!phraseResult.valid) {
      return errorPage(phraseResult.error, 400, "settings-reset-database");
    }

    await logActivity("Database reset initiated");
    if (isStorageEnabled()) {
      await deleteAllEventStorageFiles(await getAllEvents());
    }
    await resetDatabase();

    // Redirect to setup page since the database is now empty
    return ok("/setup/", "Database reset", {
      cookie: clearSessionCookie(),
    });
  },
);

/**
 * Handle POST /admin/settings/event-column-order - owner only
 */
const handleEventColumnOrderPost = settingsHandler({
  advanced: true,
  extract: (form) => form.getString("column_order").trim(),
  formId: "settings-event-column-order",
  label: "Event column order",
  save: (value) => settings.update.eventColumnOrder(value),
  validate: (value) => {
    if (!value) return null; // Empty clears to default
    return validateColumnTemplate(value, Object.keys(EVENT_TABLE_COLUMNS));
  },
});

/**
 * Handle POST /admin/settings/attendee-column-order - owner only
 */
const handleAttendeeColumnOrderPost = settingsHandler({
  advanced: true,
  extract: (form) => form.getString("column_order").trim(),
  formId: "settings-attendee-column-order",
  label: "Attendee column order",
  save: (value) => settings.update.attendeeColumnOrder(value),
  validate: (value) => {
    if (!value) return null; // Empty clears to default
    return validateColumnTemplate(value, Object.keys(ATTENDEE_TABLE_COLUMNS));
  },
});

/** Settings routes */
export const settingsRoutes = defineRoutes({
  "GET /admin/settings": handleAdminSettingsGet,
  "GET /admin/settings-advanced": handleAdminSettingsAdvancedGet,
  "POST /admin/settings": handleAdminSettingsPost,
  "POST /admin/settings/apple-wallet": handleAppleWalletPost,
  "POST /admin/settings/attendee-column-order": handleAttendeeColumnOrderPost,
  "POST /admin/settings/booking-fee": handleBookingFeePost,
  "POST /admin/settings/business-email": handleBusinessEmailPost,
  "POST /admin/settings/country": handleCountryPost,
  "POST /admin/settings/custom-domain": handleCustomDomainPost,
  "POST /admin/settings/custom-domain/validate": handleCustomDomainValidatePost,
  "POST /admin/settings/email": handleEmailPost,
  "POST /admin/settings/email-templates/admin":
    handleEmailTemplatePost("admin"),
  "POST /admin/settings/email-templates/confirmation":
    handleEmailTemplatePost("confirmation"),
  "POST /admin/settings/email-templates/preview":
    handleEmailTemplatePreviewPost,
  "POST /admin/settings/email/test": handleEmailTestPost,
  "POST /admin/settings/embed-hosts": handleEmbedHostsPost,
  "POST /admin/settings/event-column-order": handleEventColumnOrderPost,
  "POST /admin/settings/google-wallet": handleGoogleWalletPost,
  "POST /admin/settings/header-image": handleHeaderImagePost,
  "POST /admin/settings/header-image/delete": handleHeaderImageDeletePost,
  "POST /admin/settings/host-subdomain": handleHostSubdomainPost,
  "POST /admin/settings/payment-provider": handlePaymentProviderPost,
  "POST /admin/settings/reset-database": handleResetDatabasePost,
  "POST /admin/settings/show-public-api": handleShowPublicApiPost,
  "POST /admin/settings/show-public-site": handleShowPublicSitePost,
  "POST /admin/settings/square": handleAdminSquarePost,
  "POST /admin/settings/square-webhook": handleAdminSquareWebhookPost,
  "POST /admin/settings/square/test": handleSquareTestPost,
  "POST /admin/settings/stripe": handleAdminStripePost,
  "POST /admin/settings/stripe/test": handleStripeTestPost,
  "POST /admin/settings/terms": handleTermsPost,
  "POST /admin/settings/theme": handleThemePost,
});
