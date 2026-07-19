/**
 * Admin "general" settings routes - the small single-field/toggle handlers
 * plus column-order configuration and database reset. Owner-only access
 * enforced via the settings-helpers route wrappers.
 */

import { t } from "#i18n";
import {
  deleteStorageAndResetDatabase,
  demoResetForm,
} from "#routes/admin/database-reset.ts";
import {
  advancedSettingsRoute,
  settingsClearable,
  settingsHandler,
  settingsToggle,
} from "#routes/admin/settings-helpers.ts";
import { COLUMN_LAYOUTS } from "#shared/column-layout.ts";
import { clearSessionCookie } from "#shared/cookies.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { settings } from "#shared/db/settings.ts";
import {
  applyDemoOverrides,
  TERMS_DEMO_FIELDS,
} from "#shared/demo/overrides.ts";
import { parseEmbedHosts, validateEmbedHosts } from "#shared/embed-hosts.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { ok } from "#shared/response.ts";
import {
  SETTINGS_FORMS,
  type SettingsFormDefinition,
} from "#shared/settings/forms.ts";
import {
  isPaymentProvider,
  type PaymentProviderType,
  type Theme,
} from "#shared/types.ts";
import { isValidEmail, updateBusinessEmail } from "#shared/validation/email.ts";

const formRoute = (definition: SettingsFormDefinition) => ({
  advanced: definition.page === "advanced",
  field: definition.fieldName,
  formId: definition.formId,
  label: definition.routeLabel,
});

const formLocation = (definition: SettingsFormDefinition) => {
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
  validate: (v) =>
    v !== "none" && !isPaymentProvider(v)
      ? t("error.invalid_payment_provider")
      : null,
});

/**
 * Handle POST /admin/settings/embed-hosts - owner only
 */
export const handleEmbedHostsPost = settingsHandler({
  ...formLocation(SETTINGS_FORMS.embedHosts),
  extract: (form) => form.getString(SETTINGS_FORMS.embedHosts.fieldName),
  log: (v) =>
    v === ""
      ? t("success.embed_hosts_removed")
      : t("success.embed_hosts_updated"),
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
  extract: (form) => form.getString(SETTINGS_FORMS.customCss.fieldName),
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
  extract: (form) => Number.parseFloat(form.getString("booking_fee")),
  formId: "settings-booking-fee",
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
    label: "Attendee column order",
    update: settings.update.attendeeColumnOrder,
  },
  listing: {
    label: "Listing column order",
    update: settings.update.listingColumnOrder,
  },
};

type ConfigurableColumnLayoutKind = keyof typeof COLUMN_ORDER_SETTINGS;

const columnOrderHandler = (kind: ConfigurableColumnLayoutKind) => {
  const config = COLUMN_ORDER_SETTINGS[kind];
  return settingsHandler({
    advanced: true,
    extract: (form) => form.getString("column_order").trim(),
    formId: `settings-${kind}-column-order`,
    label: config.label,
    save: config.update,
    validate: COLUMN_LAYOUTS[kind].validate,
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

    await logActivity("Database reset initiated");
    await deleteStorageAndResetDatabase();

    // Redirect to setup page since the database is now empty
    return ok("/setup/", t("success.database_reset"), {
      cookie: clearSessionCookie(),
    });
  },
);
