/**
 * Admin settings route map - aggregates the owner-only settings handlers
 * from the per-feature settings-*.ts modules into a single route table.
 */

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
  handleEmailTemplatePreviewPost,
} from "#routes/admin/settings-email-templates.ts";
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
  handleResetDatabasePost,
  handleShowPublicApiPost,
  handleShowPublicSitePost,
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
  handleAdminSquarePost,
  handleAdminSquareWebhookPost,
  handleSquareTestPost,
} from "#routes/admin/settings-square.ts";
import {
  handleAdminStripePost,
  handleStripeTestPost,
} from "#routes/admin/settings-stripe.ts";
import {
  handleAdminSumupPost,
  handleSumupTestPost,
} from "#routes/admin/settings-sumup.ts";
import { handleSuperuserPost } from "#routes/admin/settings-superuser.ts";
import {
  handleAppleWalletPost,
  handleGoogleWalletPost,
} from "#routes/admin/settings-wallets.ts";
import { defineRoutes } from "#routes/router.ts";

/** Settings routes */
export const settingsRoutes = defineRoutes({
  "GET /admin/listing-defaults": handleListingDefaultsGet,
  "GET /admin/settings": handleAdminSettingsGet,
  "GET /admin/settings-advanced": handleAdminSettingsAdvancedGet,
  "POST /admin/listing-defaults": handleListingDefaultsPost,
  "POST /admin/settings": handleAdminSettingsPost,
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
  "POST /admin/settings/email-templates/preview":
    handleEmailTemplatePreviewPost,
  "POST /admin/settings/email/test": handleEmailTestPost,
  "POST /admin/settings/embed-hosts": handleEmbedHostsPost,
  "POST /admin/settings/external-order": handleExternalOrderPost,
  "POST /admin/settings/google-wallet": handleGoogleWalletPost,
  "POST /admin/settings/header-image": handleHeaderImagePost,
  "POST /admin/settings/header-image/delete": handleHeaderImageDeletePost,
  "POST /admin/settings/host-subdomain": handleHostSubdomainPost,
  "POST /admin/settings/listing-column-order": handleListingColumnOrderPost,
  "POST /admin/settings/payment-provider": handlePaymentProviderPost,
  "POST /admin/settings/reset-database": handleResetDatabasePost,
  "POST /admin/settings/show-public-api": handleShowPublicApiPost,
  "POST /admin/settings/show-public-site": handleShowPublicSitePost,
  "POST /admin/settings/sms-gateway": handleSmsGatewayPost,
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
