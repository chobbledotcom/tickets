/**
 * Admin settings page rendering - GET /admin/settings and
 * GET /admin/settings-advanced, plus the state-gathering they depend on.
 * Owner-only access enforced via ownerPage.
 */

/* jscpd:ignore-start */
import { getWebhookUrl } from "#routes/admin/settings-helpers.ts";
import { type AuthSession, ownerPage } from "#routes/auth.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { getCdnHostname } from "#shared/bunny-cdn.ts";
import {
  getBunnyDnsSubdomainSuffix,
  isBunnyCdnEnabled,
  isBunnyDnsEnabled,
} from "#shared/config.ts";
import { settings } from "#shared/db/settings.ts";
import { EMAIL_PROVIDER_LABELS, getHostEmailConfig } from "#shared/email.ts";
import { getFlash } from "#shared/flash-context.ts";
import { isStorageEnabled } from "#shared/storage.ts";
import { getSuperuserState } from "#shared/superuser.ts";
import { adminSettingsPage } from "#templates/admin/settings.tsx";
import { adminAdvancedSettingsPage } from "#templates/admin/settings-advanced.tsx";

/* jscpd:ignore-end */

/** Gather all state needed to render the settings page.
 * All calls are independent, so we fetch them concurrently with Promise.all
 * to reduce sequential await overhead (especially for calls that decrypt).
 */
const getSettingsPageState = async () => {
  const superuser = await getSuperuserState();
  return {
    bookingFee: settings.bookingFee,
    businessEmail: settings.businessEmail,
    calendarFeedsEnabled: settings.calendarFeedsEnabled,
    calendarFeedsGroupBy: settings.calendarFeedsGroupBy,
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
    listingColumnOrder: settings.listingColumnOrder,
    paymentProvider: settings.paymentProvider ?? "",
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
  subdomainPreview = "",
  subdomainPreviewFullDomain = "",
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
      flash.result?.split("\n") ?? [];
    return await renderAdvancedSettingsPage(
      session,
      subdomainPreview,
      subdomainPreviewFullDomain,
    );
  });
