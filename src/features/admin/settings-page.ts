/**
 * Admin settings page rendering - GET /admin/settings and
 * GET /admin/settings-advanced, plus the state-gathering they depend on.
 * Owner-only access enforced via ownerPage.
 */

/* jscpd:ignore-start */
import { type AuthSession, ownerPage } from "#routes/auth.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { enabledFeaturesWithUsage } from "#shared/admin-features.ts";
import { getCdnHostname } from "#shared/bunny-cdn.ts";
import {
  getBunnyDnsSubdomainSuffix,
  isBunnyCdnEnabled,
  isBunnyDnsEnabled,
} from "#shared/config.ts";
import { getAdminFeatureUsage } from "#shared/db/admin-features.ts";
import { settings } from "#shared/db/settings.ts";
import { EMAIL_PROVIDER_LABELS, getHostEmailConfig } from "#shared/email.ts";
import { getEnv } from "#shared/env.ts";
import { getFlash } from "#shared/flash-context.ts";
import { getPaymentWebhookUrl } from "#shared/payment-webhook-url.ts";
import { existingPaymentProviderType } from "#shared/payments.ts";
import { SCHEDULED_TASK_KEY_ENV } from "#shared/scheduled-keys.ts";
import { isStorageEnabled } from "#shared/storage.ts";
import { getSuperuserState } from "#shared/superuser.ts";
import { adminSettingsPage } from "#templates/admin/settings.tsx";
import { adminAdvancedSettingsPage } from "#templates/admin/settings-advanced.tsx";

/* jscpd:ignore-end */

/**
 * Gather all state needed to render the settings page.
 * All calls are independent, so we fetch them concurrently with Promise.all
 * to reduce sequential await overhead (especially for calls that decrypt).
 */
const getSettingsPageState = async () => {
  const [superuser, featureUsage] = await Promise.all([
    getSuperuserState(),
    getAdminFeatureUsage(),
  ]);
  return {
    bookingFee: settings.bookingFee,
    businessEmail: settings.businessEmail,
    calendarFeedsEnabled: settings.calendarFeedsEnabled,
    calendarFeedsGroupBy: settings.calendarFeedsGroupBy,
    currency: settings.currency,
    embedHosts: settings.embedHosts,
    enabledFeatures: enabledFeaturesWithUsage(settings.features, featureUsage),
    headerImageUrl: settings.headerImageUrl,
    lastActivePaymentProvider: existingPaymentProviderType(),
    paymentProvider: settings.paymentProvider,
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
    underlineLinks: settings.underlineLinks,
    webhookUrl: getPaymentWebhookUrl(),
  };
};

/** Render the settings page with current state */
const renderSettingsPage = async (session: AuthSession) => {
  const state = await getSettingsPageState();
  return adminSettingsPage(session, state);
};

/** Gather state for the advanced settings page */
const getAdvancedSettingsPageState = async (
  subdomainPreview: string,
  subdomainPreviewFullDomain: string,
) => {
  const bunnyCdnConfigured = isBunnyCdnEnabled();
  const bunnyDnsEnabled = isBunnyDnsEnabled();
  const confirmationTemplates = settings.email.templateSet("confirmation");
  const adminTemplates = settings.email.templateSet("admin");
  const cdnResult = bunnyCdnConfigured ? await getCdnHostname() : null;
  return {
    addressLookupApiKeyConfigured: settings.addressLookup.hasKey,
    addressLookupProvider: settings.addressLookup.provider,
    adminTemplates,
    appleWalletConfigured: settings.appleWallet.hasDbConfig,
    appleWalletPassTypeId: settings.appleWallet.passTypeId,
    appleWalletTeamId: settings.appleWallet.teamId,
    attendeeColumnOrder: settings.attendeeColumnOrder,
    bunnyCdnEnabled: bunnyCdnConfigured,
    bunnyDnsEnabled,
    bunnyDnsSubdomainSuffix: getBunnyDnsSubdomainSuffix(),
    bunnySubdomain: settings.bunnySubdomain,
    businessEmail: settings.businessEmail,
    cdnHostname: cdnResult?.ok ? cdnResult.hostname : "",
    confirmationTemplates,
    customCss: settings.customCss,
    customDomain: settings.customDomain,
    customDomainLastValidated: settings.customDomainLastValidated,
    emailApiKeyConfigured: settings.email.hasApiKey,
    emailFromAddress: settings.email.fromAddress,
    emailProvider: settings.email.provider,
    externalOrderEnabled: settings.externalOrderEnabled,
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
    lastActivePaymentProvider: existingPaymentProviderType(),
    listingColumnOrder: settings.listingColumnOrder,
    paymentProvider: settings.paymentProvider,
    scheduledTaskKey: getEnv(SCHEDULED_TASK_KEY_ENV),
    showPublicApi: settings.showPublicApi,
    smsGatewayBaseUrl: settings.smsGatewayBaseUrl,
    smsGatewayPassphraseConfigured: settings.smsGateway.hasPassphrase,
    smsGatewayPasswordConfigured: settings.smsGateway.hasPassword,
    smsGatewayUsername: settings.smsGatewayUsername,
    smsGatewayWebhookConfigured: settings.smsGateway.hasWebhookSecret,
    subdomainPreview,
    subdomainPreviewFullDomain,
    theme: settings.theme,
  };
};

/** Render the advanced settings page with current state */
const renderAdvancedSettingsPage = async (
  session: AuthSession,
  subdomainPreview: string,
  subdomainPreviewFullDomain: string,
) => {
  const state = await getAdvancedSettingsPageState(
    subdomainPreview,
    subdomainPreviewFullDomain,
  );
  return adminAdvancedSettingsPage(session, state);
};

/**
 * Handle GET /admin/settings - owner only
 */
export const handleAdminSettingsGet: TypedRouteHandler<"GET /admin/settings"> =
  ownerPage((session) => renderSettingsPage(session));

/**
 * Handle GET /admin/settings-advanced - owner only
 */
export const handleAdminSettingsAdvancedGet: TypedRouteHandler<"GET /admin/settings-advanced"> =
  ownerPage(async (session) => {
    const flash = getFlash();
    const [subdomainPreview = "", subdomainPreviewFullDomain = ""] =
      flash.result ? flash.result.split("\n") : [];
    return await renderAdvancedSettingsPage(
      session,
      subdomainPreview,
      subdomainPreviewFullDomain,
    );
  });
