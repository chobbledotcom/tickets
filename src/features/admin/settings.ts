import { defineAdminRoutes } from "#routes/admin/route-tables.ts";
/**
 * Admin settings route map - aggregates the owner-only settings handlers
 * from the per-feature settings-*.ts modules into a single route table.
 */

import { handleAddressLookupPost } from "#routes/admin/settings-address-lookup.ts";
import {
  handleCustomDomainPost,
  handleCustomDomainValidatePost,
  handleHostSubdomainPost,
} from "#routes/admin/settings-domains.ts";
import {
  handleEmailPost,
  handleEmailTestPost,
} from "#routes/admin/settings-email.ts";
import { handleEmailTemplatePost } from "#routes/admin/settings-email-templates.ts";
import {
  handleFeatureGet,
  handleFeaturePost,
} from "#routes/admin/settings-features.ts";
import {
  handleAttendeeColumnOrderPost,
  handleBookingFeePost,
  handleBusinessEmailPost,
  handleCalendarFeedsPost,
  handleCustomCssPost,
  handleDashboardTypePost,
  handleEmbedHostsPost,
  handleExternalOrderPost,
  handleListingColumnOrderPost,
  handleListingModePost,
  handlePaymentProviderPost,
  handlePaymentProviderRecoveryPost,
  handleResetDatabasePost,
  handleShowPublicApiPost,
  handleSiteFooterPost,
  handleTermsPost,
  handleThemePost,
} from "#routes/admin/settings-general.ts";
import {
  handleHeaderImageDeletePost,
  handleHeaderImagePost,
} from "#routes/admin/settings-header-image.ts";
import {
  handleListingDefaultsGet,
  handleListingDefaultsPost,
} from "#routes/admin/settings-listing-defaults.ts";
import { handleLogisticsRunSheetPost } from "#routes/admin/settings-logistics-run-sheet.ts";
import {
  handleAdminSettingsAdvancedGet,
  handleAdminSettingsGet,
} from "#routes/admin/settings-page.ts";
import { handleAdminSettingsPost } from "#routes/admin/settings-password.ts";
import { handleSmsGatewayPost } from "#routes/admin/settings-sms.ts";
import {
  handleAdminSquareWebhookPost,
  squareRoutes,
} from "#routes/admin/settings-square.ts";
import { stripeRoutes } from "#routes/admin/settings-stripe.ts";
import { sumupRoutes } from "#routes/admin/settings-sumup.ts";
import { handleSuperuserPost } from "#routes/admin/settings-superuser.ts";
import { handleTaxPost } from "#routes/admin/settings-tax.ts";
import {
  handleAppleWalletPost,
  handleGoogleWalletPost,
} from "#routes/admin/settings-wallets.ts";
import type { RequestRoute } from "#shared/response-steps.ts";
import {
  SETTINGS_FORM_DEFINITIONS,
  type SettingsFormName,
} from "#shared/settings/forms.ts";

/** The request handler that saves one settings form. The switch is exhaustive:
 *  without a `default`, a new form fails to compile until it returns here. */
const formHandler = (name: SettingsFormName): RequestRoute => {
  switch (name) {
    case "addressLookup":
      return handleAddressLookupPost;
    case "attendeeColumnOrder":
      return handleAttendeeColumnOrderPost;
    case "bookingFee":
      return handleBookingFeePost;
    case "businessEmail":
      return handleBusinessEmailPost;
    case "calendarFeeds":
      return handleCalendarFeedsPost;
    case "customCss":
      return handleCustomCssPost;
    case "dashboardType":
      return handleDashboardTypePost;
    case "embedHosts":
      return handleEmbedHostsPost;
    case "externalOrder":
      return handleExternalOrderPost;
    case "listingColumnOrder":
      return handleListingColumnOrderPost;
    case "listingMode":
      return handleListingModePost;
    case "showPublicApi":
      return handleShowPublicApiPost;
    case "siteFooter":
      return handleSiteFooterPost;
    case "tax":
      return handleTaxPost;
    case "terms":
      return handleTermsPost;
    case "theme":
      return handleThemePost;
  }
};

type SettingsFormAction = (typeof SETTINGS_FORM_DEFINITIONS)[number]["action"];
type SettingsFormRoute = `POST ${SettingsFormAction}`;

/** The simple form POST routes, generated from the form definition table. */
const settingsFormRoutes = Object.fromEntries(
  SETTINGS_FORM_DEFINITIONS.map((definition) => [
    `POST ${definition.action}`,
    formHandler(definition.name),
  ]),
) as { [Key in SettingsFormRoute]: RequestRoute };

/** Settings routes */
export const adminHandlers = defineAdminRoutes({
  ...settingsFormRoutes,
  "GET /admin/features/:slug": handleFeatureGet,
  "GET /admin/listing-defaults": handleListingDefaultsGet,
  "GET /admin/settings": handleAdminSettingsGet,
  "GET /admin/settings-advanced": handleAdminSettingsAdvancedGet,
  "POST /admin/features/:slug": handleFeaturePost,
  "POST /admin/listing-defaults": handleListingDefaultsPost,
  "POST /admin/settings": handleAdminSettingsPost,
  "POST /admin/settings/apple-wallet": handleAppleWalletPost,
  "POST /admin/settings/custom-domain": handleCustomDomainPost,
  "POST /admin/settings/custom-domain/validate": handleCustomDomainValidatePost,
  "POST /admin/settings/email": handleEmailPost,
  "POST /admin/settings/email-templates/admin":
    handleEmailTemplatePost("admin"),
  "POST /admin/settings/email-templates/confirmation":
    handleEmailTemplatePost("confirmation"),
  "POST /admin/settings/email/test": handleEmailTestPost,
  "POST /admin/settings/google-wallet": handleGoogleWalletPost,
  "POST /admin/settings/header-image": handleHeaderImagePost,
  "POST /admin/settings/header-image/delete": handleHeaderImageDeletePost,
  "POST /admin/settings/host-subdomain": handleHostSubdomainPost,
  "POST /admin/settings/logistics-run-sheet": handleLogisticsRunSheetPost,
  "POST /admin/settings/payment-provider": handlePaymentProviderPost,
  "POST /admin/settings/payment-provider-recovery":
    handlePaymentProviderRecoveryPost,
  "POST /admin/settings/reset-database": handleResetDatabasePost,
  "POST /admin/settings/sms-gateway": handleSmsGatewayPost,
  "POST /admin/settings/square": squareRoutes.save,
  "POST /admin/settings/square-webhook": handleAdminSquareWebhookPost,
  "POST /admin/settings/square/test": squareRoutes.test,
  "POST /admin/settings/stripe": stripeRoutes.save,
  "POST /admin/settings/stripe/test": stripeRoutes.test,
  "POST /admin/settings/sumup": sumupRoutes.save,
  "POST /admin/settings/sumup/test": sumupRoutes.test,
  "POST /admin/settings/superuser": handleSuperuserPost,
});
