/**
 * Admin settings routes - password, payment provider, and key configuration
 * Owner-only access enforced via requireOwnerOr / withAuth
 */

import { demoResetForm } from "#routes/admin/database-reset.ts";
import {
  handleCustomDomainPost,
  handleCustomDomainValidatePost,
  handleHostSubdomainPost,
} from "#routes/admin/settings-domains.ts";
import {
  handleEmailTemplatePost,
  handleEmailTemplatePreviewPost,
} from "#routes/admin/settings-email-templates.ts";
import {
  advancedSettingsRoute,
  processSecretField,
  type SecretFieldResult,
  settingsClearable,
  settingsHandler,
  settingsRoute,
  settingsSecret,
  settingsToggle,
  testRoute,
} from "#routes/admin/settings-helpers.ts";
import {
  handleAdminSumupPost,
  handleSumupTestPost,
} from "#routes/admin/settings-sumup.ts";
import {
  handleAppleWalletPost,
  handleGoogleWalletPost,
} from "#routes/admin/settings-wallets.ts";
import {
  type AuthSession,
  OWNER_MULTIPART,
  ownerPage,
  withAuth,
} from "#routes/auth.ts";
import { errorRedirect } from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { getCdnHostname } from "#shared/bunny-cdn.ts";
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
import { unwrapKeyWithToken } from "#shared/crypto/keys.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { getAllEvents } from "#shared/db/events.ts";
import { resetDatabase } from "#shared/db/migrations.ts";
import { settings } from "#shared/db/settings.ts";
import {
  deleteUser,
  getUserById,
  verifyUserPassword,
} from "#shared/db/users.ts";
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
import { parseEmbedHosts, validateEmbedHosts } from "#shared/embed-hosts.ts";
import { getFlash } from "#shared/flash-context.ts";
import type { FormParams } from "#shared/form-data.ts";
import { validateForm } from "#shared/forms.tsx";
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
import {
  createActivatedSuperuser,
  generateSuperuserPassword,
  getSuperuserState,
  sendSuperuserCredentialsEmail,
} from "#shared/superuser.ts";
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
const getSettingsPageState = async () => {
  const superuser = await getSuperuserState();
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
    sumupKeyConfigured: settings.sumup.hasKey,
    sumupKeyMode: settings.sumup.keyMode,
    superuser,
    termsAndConditions: settings.terms,
    theme: settings.theme,
    webhookUrl: getWebhookUrl(),
  };
};

/** Render the settings page with current state */
const renderSettingsPage = async (session: AuthSession) => {
  const state = await getSettingsPageState();
  return adminSettingsPage(session, state);
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
  s === "stripe" || s === "square" || s === "sumup";

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
 * Build a column-order settings handler for the event or attendee table.
 * Handles POST /admin/settings/{event,attendee}-column-order - owner only
 */
const columnOrderHandler = (kind: "event" | "attendee") => {
  const columns =
    kind === "event" ? EVENT_TABLE_COLUMNS : ATTENDEE_TABLE_COLUMNS;
  const update =
    kind === "event"
      ? settings.update.eventColumnOrder
      : settings.update.attendeeColumnOrder;
  const label =
    kind === "event" ? "Event column order" : "Attendee column order";
  return settingsHandler({
    advanced: true,
    extract: (form) => form.getString("column_order").trim(),
    formId: `settings-${kind}-column-order`,
    label,
    save: (value) => update(value),
    // Empty value clears to the default column order
    validate: (value) =>
      value ? validateColumnTemplate(value, Object.keys(columns)) : null,
  });
};

const handleEventColumnOrderPost = columnOrderHandler("event");
const handleAttendeeColumnOrderPost = columnOrderHandler("attendee");

/** Roll back a created superuser after email failure and return error page */
const rollbackSuperuser = async (
  userId: number,
  errorPage: (
    msg: string,
    status: number,
    id: string,
  ) => Response | Promise<Response>,
): Promise<Response> => {
  try {
    await deleteUser(userId);
  } catch (deleteErr) {
    const detail =
      deleteErr instanceof Error ? deleteErr.message : String(deleteErr);
    logError({
      code: ErrorCode.DB_QUERY,
      detail: `Failed to delete superuser after email failure: ${detail}`,
    });
  }
  return errorPage(
    "Failed to send superuser credentials email. The user has not been created.",
    502,
    "settings-superuser",
  );
};

/**
 * Handle POST /admin/settings/superuser - owner only
 */
const handleSuperuserPost = settingsRoute(async (form, errorPage, session) => {
  const superuser = await getSuperuserState();
  if (!superuser.available) {
    return errorPage("Superuser is not available", 400, "settings-superuser");
  }

  const choice = form.getString("superuser_choice");

  if (choice !== "self-managed" && choice !== "enable-superuser") {
    return errorPage("Invalid choice", 400, "settings-superuser");
  }

  if (superuser.userExists) {
    const existingUserMessage = superuser.activated
      ? `Superuser ${superuser.username} is already activated. You can delete them from your users page.`
      : `Username ${superuser.username} already exists. You can delete them from your users page before enabling a superuser.`;
    return errorPage(existingUserMessage, 400, "settings-superuser");
  }

  if (choice === "self-managed") {
    await settings.update.superuserChoice("self-managed");
    await logActivity("Superuser recovery declined");
    return ok("/admin/settings", "Superuser recovery declined", {
      formId: "settings-superuser",
    });
  }

  // Confirm email config
  const config = (await getEmailConfig()) ?? getHostEmailConfig();
  if (!config) {
    return errorPage(
      "Email must be configured before enabling a superuser",
      400,
      "settings-superuser",
    );
  }

  if (!session.wrappedDataKey) {
    return errorPage(
      "Cannot enable superuser: session lacks data key",
      500,
      "settings-superuser",
    );
  }

  const dataKey = await unwrapKeyWithToken(
    session.wrappedDataKey,
    session.token,
  );
  const password = generateSuperuserPassword(12);
  const user = await createActivatedSuperuser({
    dataKey,
    password,
    username: superuser.username,
  });

  const emailOk = await sendSuperuserCredentialsEmail(config, {
    email: superuser.email,
    password,
    username: superuser.username,
  });

  if (!emailOk) {
    return rollbackSuperuser(user.id, errorPage);
  }

  await settings.update.superuserChoice("enabled");
  await logActivity(`Superuser '${superuser.username}' enabled`);
  return ok("/admin/settings", "Superuser enabled and credentials sent", {
    formId: "settings-superuser",
  });
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
  "POST /admin/settings/sumup": handleAdminSumupPost,
  "POST /admin/settings/sumup/test": handleSumupTestPost,
  "POST /admin/settings/superuser": handleSuperuserPost,
  "POST /admin/settings/terms": handleTermsPost,
  "POST /admin/settings/theme": handleThemePost,
});
