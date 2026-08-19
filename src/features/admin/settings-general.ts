/**
 * Admin "general" settings routes - the small single-field/toggle handlers
 * plus column-order configuration and database reset. Owner-only access
 * enforced via the settings-helpers route wrappers.
 */

/* jscpd:ignore-start -- imports */
import { logActivity } from "#db/activity-log.ts";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import {
  /* jscpd:ignore-end */
  deleteStorageAndResetDatabase,
  demoResetForm,
} from "#routes/admin/database-reset.ts";
import {
  advancedSettingsRoute,
  settingsClearable,
  settingsHandler,
  settingsRoute,
  settingsToggle,
} from "#routes/admin/settings-helpers.ts";
import { redirect } from "#routes/response.ts";
import { clearSessionCookie } from "#shared/cookies.ts";
import {
  applyDemoOverrides,
  TERMS_DEMO_FIELDS,
} from "#shared/demo/overrides.ts";
import { parseEmbedHosts, validateEmbedHosts } from "#shared/embed-hosts.ts";
import { existingPaymentProviderState } from "#shared/existing-payment-provider.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  PAYMENT_PROVIDERS,
  providerCurrencyBlock,
} from "#shared/payment-providers.ts";
import { ok } from "#shared/response.ts";
import type { RequestRoute } from "#shared/response-steps.ts";
import {
  SETTINGS_FORMS,
  type SingleFieldSettingsForm,
} from "#shared/settings/forms.ts";
import { configurableTableLayouts } from "#shared/tables/configurable.ts";
import { isValidEmail, updateBusinessEmail } from "#shared/validation/email.ts";
import {
  isPaymentProvider,
  type PaymentProviderType,
  type Theme,
} from "#types";

const formRoute = (definition: SingleFieldSettingsForm) => ({
  advanced: definition.page === "advanced",
  field: definition.fieldName,
  formId: definition.formId,
  label: definition.routeLabel,
});

const formLocation = (definition: SingleFieldSettingsForm) => {
  const { label: _, ...location } = formRoute(definition);
  return location;
};

/**
 * Handle POST /admin/settings/payment-provider - owner only
 */
export const handlePaymentProviderPost = settingsHandler({
  extract: (form) => form.getString("payment_provider"),
  formId: "settings-payment-provider",
  log: (v) =>
    v === "none"
      ? t("success.payment_provider_disabled")
      : `Payment provider set to ${v}`,
  save: (v) =>
    v === "none"
      ? settings.update.setPaymentProviderNone()
      : settings.update.paymentProvider(v as PaymentProviderType),
  taskName: "payment-provider",
  validate: (v) => {
    if (v === "none") return null;
    if (!isPaymentProvider(v)) return t("error.invalid_payment_provider");
    if (existingPaymentProviderState().recoveryChoices.length > 0) {
      return t("error.payment_provider_activation_requires_recovery");
    }
    // The page switches this off already; refuse it here too.
    return providerCurrencyBlock(v, settings.currency);
  },
});

/** Record the provider for old payments without turning new sales on. */
export const handlePaymentProviderRecoveryPost: RequestRoute = settingsRoute(
  async (form, errorPage) => {
    const formId = "settings-payment-provider-recovery";
    const provider = form.getString("existing_payment_provider");
    if (settings.paymentProvider) {
      return errorPage(
        t("error.payment_provider_recovery_unavailable"),
        formId,
      );
    }
    if (
      !isPaymentProvider(provider) ||
      !existingPaymentProviderState().recoveryChoices.includes(provider)
    ) {
      return errorPage(t("error.invalid_existing_payment_provider"), formId);
    }
    const expectedVersion = form.getOptionalInt("settings_version");
    const task = await settings.withCurrentTask(
      "payment-provider",
      async () => {
        await settings.update.recoverPaymentProvider(provider);
        const message = t("success.existing_payment_provider_set", {
          provider: PAYMENT_PROVIDERS[provider].label,
        });
        await logActivity(message);
        return redirect("/admin/settings", message, true, { formId });
      },
      expectedVersion,
    );
    if (!task.ok) return errorPage(task.error, formId);
    return task.value;
  },
);

/**
 * Handle POST /admin/settings/embed-hosts - owner only
 */
export const handleEmbedHostsPost = settingsHandler({
  ...formLocation(SETTINGS_FORMS.embedHosts),
  log: (v) =>
    v === ""
      ? t("success.embed_hosts_removed")
      : t("success.embed_hosts_updated"),
  // An empty list parses to "" and validates fine, so clearing needs no case.
  save: (v) => settings.update.embedHosts(parseEmbedHosts(v).join(", ")),
  validate: validateEmbedHosts,
});

/**
 * Handle POST /admin/settings/terms - owner only
 */
export const handleTermsPost = settingsHandler({
  ...formLocation(SETTINGS_FORMS.terms),
  extract: (form) => {
    applyDemoOverrides(form, TERMS_DEMO_FIELDS);
    return form.getString(SETTINGS_FORMS.terms.fieldName);
  },
  log: (v) =>
    v === "" ? t("success.terms_removed") : t("success.terms_updated"),
  save: (v) => settings.update.terms(v),
  validate: (v) =>
    v.length > MAX_TEXTAREA_LENGTH
      ? `Terms must be ${MAX_TEXTAREA_LENGTH} characters or fewer (currently ${v.length})`
      : null,
});

/**
 * Handle POST /admin/settings/custom-css - owner only.
 * Stored verbatim and served as a public stylesheet from /custom.css.
 */
export const handleCustomCssPost = settingsHandler({
  ...formLocation(SETTINGS_FORMS.customCss),
  log: (v) => (v === "" ? "Custom CSS removed" : "Custom CSS updated"),
  save: (v) => settings.update.customCss(v),
  validate: (v) =>
    v.length > MAX_TEXTAREA_LENGTH
      ? `Custom CSS must be ${MAX_TEXTAREA_LENGTH} characters or fewer (currently ${v.length})`
      : null,
});

/** Handle POST /admin/settings/business-email - owner only */
export const handleBusinessEmailPost = settingsClearable({
  ...formRoute(SETTINGS_FORMS.businessEmail),
  save: (v) => updateBusinessEmail(v),
  validate: (v) => (!isValidEmail(v) ? t("error.email_format") : null),
});

/** Handle POST /admin/settings/theme - owner only. The Site Theme form also
 * carries the "Underline links" checkbox, so this saves both the theme and the
 * underline-links toggle (off when the checkbox is absent) in one submission. */
export const handleThemePost = settingsHandler({
  extract: (form) => ({
    theme: form.getString("theme"),
    underlineLinks: form.get("underline_links") === "true",
  }),
  formId: "settings-theme",
  log: (v) => `Theme set to ${v.theme}`,
  save: async (v) => {
    await settings.update.theme(v.theme as Theme);
    await settings.update.underlineLinks(v.underlineLinks);
  },
  validate: (v) =>
    v.theme !== "light" && v.theme !== "dark" ? t("error.invalid_theme") : null,
});

/** Handle POST /admin/settings/show-public-api - owner only */
export const handleShowPublicApiPost = settingsToggle({
  ...formRoute(SETTINGS_FORMS.showPublicApi),
  save: (v) => settings.update.showPublicApi(v),
});

/** Handle POST /admin/settings/external-order - owner only */
export const handleExternalOrderPost = settingsToggle({
  ...formRoute(SETTINGS_FORMS.externalOrder),
  save: (v) => settings.update.externalOrderEnabled(v),
});

/** Handle POST /admin/settings/calendar-feeds - owner only */
export const handleCalendarFeedsPost = settingsHandler({
  extract: (form) => ({
    enabled: form.getString("calendar_feeds_enabled") === "true",
    groupBy: form.getString("calendar_feeds_group_by"),
  }),
  formId: "settings-calendar-feeds",
  log: (v) =>
    v.enabled
      ? `Calendar feeds enabled (${v.groupBy})`
      : "Calendar feeds disabled",
  save: async (v) => {
    await settings.update.calendarFeedsEnabled(v.enabled);
    await settings.update.calendarFeedsGroupBy(
      v.groupBy === "listings" ? "listings" : "attendees",
    );
  },
});

/** Handle POST /admin/settings/booking-fee - owner only */
export const handleBookingFeePost = settingsHandler({
  ...formLocation(SETTINGS_FORMS.bookingFee),
  extract: (form) =>
    Number.parseFloat(form.getString(SETTINGS_FORMS.bookingFee.fieldName)),
  log: (v) => `Booking fee set to ${v}%`,
  save: (v) => settings.update.bookingFee(String(v)),
  validate: (v) =>
    !Number.isFinite(v) || v < 0 || v > 10
      ? t("error.booking_fee_range")
      : null,
});

/**
 * Build a column-order settings handler for the listing or attendee table.
 * Handles POST /admin/settings/{listing,attendee}-column-order - owner only
 */
const COLUMN_ORDER_SETTINGS = {
  attendee: {
    form: SETTINGS_FORMS.attendeeColumnOrder,
    message: () => t("settings.column_order.attendee_updated"),
    update: settings.update.attendeeColumnOrder,
  },
  listing: {
    form: SETTINGS_FORMS.listingColumnOrder,
    message: () => t("settings.column_order.listing_updated"),
    update: settings.update.listingColumnOrder,
  },
};

type ConfigurableColumnLayoutKind = keyof typeof COLUMN_ORDER_SETTINGS;

const columnOrderHandler = (kind: ConfigurableColumnLayoutKind) => {
  const config = COLUMN_ORDER_SETTINGS[kind];
  const layout = configurableTableLayouts[kind];
  return settingsHandler({
    ...formLocation(config.form),
    extract: (form) => form.getString(config.form.fieldName).trim(),
    log: config.message,
    save: config.update,
    validate: (value) =>
      layout.validate(value) === null
        ? null
        : t("settings.column_order.invalid", {
            columns: layout.keys.join(", "),
          }),
  });
};

export const handleListingColumnOrderPost = columnOrderHandler("listing");
export const handleAttendeeColumnOrderPost = columnOrderHandler("attendee");

/**
 * Handle POST /admin/settings/reset-database - owner only
 */
export const handleResetDatabasePost = advancedSettingsRoute(
  async (form, errorPage) => {
    const phraseResult = demoResetForm.validate(form);
    if (!phraseResult.valid) {
      return errorPage(phraseResult.error, "settings-reset-database");
    }

    // No activity-log line: the reset drops the table it would be written to.
    await deleteStorageAndResetDatabase();

    // Redirect to setup page since the database is now empty
    return ok("/setup/", t("success.database_reset"), {
      cookie: clearSessionCookie(),
    });
  },
);
