import { handlersFor } from "#routes/admin/handlers.ts";
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
  handleEmailTemplatePreviewPost,
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
export const adminHandlers = handlersFor("settings")({
  getFeaturesBySlug: handleFeatureGet,
  getListingDefaults: handleListingDefaultsGet,
  getSettings: handleAdminSettingsGet,
  getSettingsAdvanced: handleAdminSettingsAdvancedGet,
  postFeaturesBySlug: handleFeaturePost,
  postListingDefaults: handleListingDefaultsPost,
  postSettings: handleAdminSettingsPost,
  postSettingsAddressLookup: handleAddressLookupPost,
  postSettingsAppleWallet: handleAppleWalletPost,
  postSettingsAttendeeColumnOrder: handleAttendeeColumnOrderPost,
  postSettingsBookingFee: handleBookingFeePost,
  postSettingsBusinessEmail: handleBusinessEmailPost,
  postSettingsCalendarFeeds: handleCalendarFeedsPost,
  postSettingsCustomCss: handleCustomCssPost,
  postSettingsCustomDomain: handleCustomDomainPost,
  postSettingsCustomDomainValidate: handleCustomDomainValidatePost,
  postSettingsEmail: handleEmailPost,
  postSettingsEmailTemplatesAdmin: handleEmailTemplatePost("admin"),
  postSettingsEmailTemplatesConfirmation:
    handleEmailTemplatePost("confirmation"),
  postSettingsEmailTemplatesPreview: handleEmailTemplatePreviewPost,
  postSettingsEmailTest: handleEmailTestPost,
  postSettingsEmbedHosts: handleEmbedHostsPost,
  postSettingsExternalOrder: handleExternalOrderPost,
  postSettingsGoogleWallet: handleGoogleWalletPost,
  postSettingsHeaderImage: handleHeaderImagePost,
  postSettingsHeaderImageDelete: handleHeaderImageDeletePost,
  postSettingsHostSubdomain: handleHostSubdomainPost,
  postSettingsListingColumnOrder: handleListingColumnOrderPost,
  postSettingsPaymentProvider: handlePaymentProviderPost,
  postSettingsResetDatabase: handleResetDatabasePost,
  postSettingsShowPublicApi: handleShowPublicApiPost,
  postSettingsShowPublicSite: handleShowPublicSitePost,
  postSettingsSmsGateway: handleSmsGatewayPost,
  postSettingsSquare: squareRoutes.save,
  postSettingsSquareTest: squareRoutes.test,
  postSettingsSquareWebhook: handleAdminSquareWebhookPost,
  postSettingsStripe: stripeRoutes.save,
  postSettingsStripeTest: stripeRoutes.test,
  postSettingsSumup: sumupRoutes.save,
  postSettingsSumupTest: sumupRoutes.test,
  postSettingsSuperuser: handleSuperuserPost,
  postSettingsTerms: handleTermsPost,
  postSettingsTheme: handleThemePost,
});
