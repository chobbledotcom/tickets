import { defineRoutes } from "#routes/router.ts";
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
import {
  handleEmailTemplatePost,
} from "#routes/admin/settings-email-templates.ts";
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
  handleEmbedHostsPost,
  handleExternalOrderPost,
  handleListingColumnOrderPost,
  handlePaymentProviderPost,
  handlePaymentProviderRecoveryPost,
  handleResetDatabasePost,
  handleShowPublicApiPost,
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
import {
  handleAppleWalletPost,
  handleGoogleWalletPost,
} from "#routes/admin/settings-wallets.ts";

/** Settings routes */
export const adminHandlers = defineRoutes({
  "GET /admin/features/:slug": handleFeatureGet,
  "GET /admin/listing-defaults": handleListingDefaultsGet,
  "GET /admin/settings": handleAdminSettingsGet,
  "GET /admin/settings-advanced": handleAdminSettingsAdvancedGet,
  "POST /admin/features/:slug": handleFeaturePost,
  "POST /admin/listing-defaults": handleListingDefaultsPost,
  "POST /admin/settings": handleAdminSettingsPost,
  "POST /admin/settings/address-lookup": handleAddressLookupPost,
  "POST /admin/settings/apple-wallet": handleAppleWalletPost,
  "POST /admin/settings/attendee-column-order": handleAttendeeColumnOrderPost,
  "POST /admin/settings/booking-fee": handleBookingFeePost,
  "POST /admin/settings/business-email": handleBusinessEmailPost,
  "POST /admin/settings/calendar-feeds": handleCalendarFeedsPost,
  "POST /admin/settings/custom-css": handleCustomCssPost,
  "POST /admin/settings/custom-domain": handleCustomDomainPost,
  "POST /admin/settings/custom-domain/validate": handleCustomDomainValidatePost,
  "POST /admin/settings/email": handleEmailPost,
  "POST /admin/settings/email-templates/admin":
    handleEmailTemplatePost("admin"),
  "POST /admin/settings/email-templates/confirmation":
    handleEmailTemplatePost("confirmation"),
  "POST /admin/settings/email/test": handleEmailTestPost,
  "POST /admin/settings/embed-hosts": handleEmbedHostsPost,
  "POST /admin/settings/external-order": handleExternalOrderPost,
  "POST /admin/settings/google-wallet": handleGoogleWalletPost,
  "POST /admin/settings/header-image": handleHeaderImagePost,
  "POST /admin/settings/header-image/delete": handleHeaderImageDeletePost,
  "POST /admin/settings/host-subdomain": handleHostSubdomainPost,
  "POST /admin/settings/listing-column-order": handleListingColumnOrderPost,
  "POST /admin/settings/payment-provider": handlePaymentProviderPost,
  "POST /admin/settings/payment-provider-recovery":
    handlePaymentProviderRecoveryPost,
  "POST /admin/settings/reset-database": handleResetDatabasePost,
  "POST /admin/settings/show-public-api": handleShowPublicApiPost,
  "POST /admin/settings/sms-gateway": handleSmsGatewayPost,
  "POST /admin/settings/square": squareRoutes.save,
  "POST /admin/settings/square-webhook": handleAdminSquareWebhookPost,
  "POST /admin/settings/square/test": squareRoutes.test,
  "POST /admin/settings/stripe": stripeRoutes.save,
  "POST /admin/settings/stripe/test": stripeRoutes.test,
  "POST /admin/settings/sumup": sumupRoutes.save,
  "POST /admin/settings/sumup/test": sumupRoutes.test,
  "POST /admin/settings/superuser": handleSuperuserPost,
  "POST /admin/settings/terms": handleTermsPost,
  "POST /admin/settings/theme": handleThemePost,
});
