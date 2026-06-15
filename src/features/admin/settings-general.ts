/**
 * Admin "general" settings routes - the small single-field/toggle handlers
 * plus column-order configuration and database reset. Owner-only access
 * enforced via the settings-helpers route wrappers.
 */

import { demoResetForm } from "#routes/admin/database-reset.ts";
import {
  advancedSettingsRoute,
  settingsClearable,
  settingsHandler,
  settingsToggle,
} from "#routes/admin/settings-helpers.ts";
import { validateColumnTemplate } from "#shared/column-order.ts";
import { ATTENDEE_TABLE_COLUMNS } from "#shared/columns/attendee-columns.ts";
import { LISTING_TABLE_COLUMNS } from "#shared/columns/listing-columns.ts";
import { clearSessionCookie } from "#shared/cookies.ts";
import { isValidCountry } from "#shared/countries.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { getAllListings } from "#shared/db/listings.ts";
import { resetDatabase } from "#shared/db/migrations.ts";
import { settings } from "#shared/db/settings.ts";
import { applyDemoOverrides, TERMS_DEMO_FIELDS } from "#shared/demo.ts";
import { parseEmbedHosts, validateEmbedHosts } from "#shared/embed-hosts.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import type { PaymentProviderType } from "#shared/payments.ts";
import { ok } from "#shared/response.ts";
import {
  deleteAllListingStorageFiles,
  isStorageEnabled,
} from "#shared/storage.ts";
import type { Theme } from "#shared/types.ts";
import { isValidEmail, updateBusinessEmail } from "#shared/validation/email.ts";

/** Type guard: check if a string is a valid payment provider */
const isPaymentProvider = (s: string): s is PaymentProviderType =>
  s === "stripe" || s === "square" || s === "sumup";

/**
 * Handle POST /admin/settings/payment-provider - owner only
 */
export const handlePaymentProviderPost = settingsHandler({
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
 * Handle POST /admin/settings/embed-hosts - owner only
 */
export const handleEmbedHostsPost = settingsHandler({
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
export const handleTermsPost = settingsHandler({
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
export const handleCountryPost = settingsHandler({
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
export const handleBusinessEmailPost = settingsClearable({
  field: "business_email",
  formId: "settings-business-email",
  label: "Business email",
  save: (v) => updateBusinessEmail(v),
  validate: (v) =>
    !isValidEmail(v)
      ? "Invalid email format. Please use format: name@domain.com"
      : null,
});

/** Handle POST /admin/settings/theme - owner only */
export const handleThemePost = settingsHandler({
  extract: (form) => form.getString("theme"),
  formId: "settings-theme",
  label: "Theme",
  log: (v) => `Theme set to ${v}`,
  save: (v) => settings.update.theme(v as Theme),
  validate: (v) =>
    v !== "light" && v !== "dark" ? "Invalid theme selection" : null,
});

/** Handle POST /admin/settings/show-public-site - owner only */
export const handleShowPublicSitePost = settingsToggle({
  field: "show_public_site",
  formId: "settings-show-public-site",
  label: "Public site",
  save: (v) => settings.update.showPublicSite(v),
});

/** Handle POST /admin/settings/show-public-api - owner only */
export const handleShowPublicApiPost = settingsToggle({
  advanced: true,
  field: "show_public_api",
  formId: "settings-show-public-api",
  label: "Public API",
  save: (v) => settings.update.showPublicApi(v),
});

/** Handle POST /admin/settings/booking-fee - owner only */
export const handleBookingFeePost = settingsHandler({
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

/**
 * Build a column-order settings handler for the listing or attendee table.
 * Handles POST /admin/settings/{listing,attendee}-column-order - owner only
 */
const columnOrderHandler = (kind: "listing" | "attendee") => {
  const columns =
    kind === "listing" ? LISTING_TABLE_COLUMNS : ATTENDEE_TABLE_COLUMNS;
  const update =
    kind === "listing"
      ? settings.update.listingColumnOrder
      : settings.update.attendeeColumnOrder;
  const label =
    kind === "listing" ? "Listing column order" : "Attendee column order";
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

export const handleListingColumnOrderPost = columnOrderHandler("listing");
export const handleAttendeeColumnOrderPost = columnOrderHandler("attendee");

/**
 * Handle POST /admin/settings/reset-database - owner only
 */
export const handleResetDatabasePost = advancedSettingsRoute(
  async (form, errorPage) => {
    const phraseResult = demoResetForm.validate(form);
    if (!phraseResult.valid) {
      return errorPage(phraseResult.error, 400, "settings-reset-database");
    }

    await logActivity("Database reset initiated");
    if (isStorageEnabled()) {
      await deleteAllListingStorageFiles(await getAllListings());
    }
    await resetDatabase();

    // Redirect to setup page since the database is now empty
    return ok("/setup/", "Database reset", {
      cookie: clearSessionCookie(),
    });
  },
);
