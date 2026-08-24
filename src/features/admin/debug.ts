/* jscpd:ignore-start */
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";

/* jscpd:ignore-end */
/**
 * Admin debug route - shows configuration status for troubleshooting
 * Owner-only access enforced via requireOwnerOr
 */

import { isValidRsaPrivateKey } from "#crypto/rsa-private-key.ts";
import { databaseHostFor } from "#db/host.ts";
import { SCHEMA_HASH } from "#db/migrations.ts";
import { settings } from "#db/settings.ts";
/* jscpd:ignore-start */
import { t } from "#i18n";
import { gatedPost, OWNER_FORM, ownerPage } from "#routes/auth.ts";
import {
  isValidAppleCertificate,
  isValidCertificate,
} from "#shared/apple-wallet/certificate.ts";
import { isValidAppleSigningPair } from "#shared/apple-wallet/cms.ts";
import { BUILD_COMMIT, BUILD_TIMESTAMP } from "#shared/build-info.ts";
import { getCdnHostname } from "#shared/bunny-cdn.ts";
import {
  getBunnyDnsSubdomainSuffix,
  getEffectiveDomain,
  isBotpoisonEnabled,
  isBunnyCdnEnabled,
  isBunnyDnsEnabled,
  isPaymentsEnabled,
  providerValue,
} from "#shared/config.ts";
import { getHostEmailConfig } from "#shared/email.ts";
import {
  getEnv,
  getReadOnlyCutoffIso,
  getRenewalUrl,
  isReadOnly,
  isReadOnlyWarning,
} from "#shared/env.ts";
import { LIMIT_ENTRIES } from "#shared/limits.ts";
import { nowIso } from "#shared/now.ts";
import {
  type PaymentProviderMode,
  paymentProviderMode,
} from "#shared/payment-provider-status.ts";
import { fail, ok } from "#shared/response.ts";
import { getRuntimeInfo } from "#shared/runtime.ts";
import { sendSentryTest } from "#shared/sentry.ts";
import { getStorageBackend } from "#shared/storage.ts";
import {
  adminDebugPage,
  type DebugPageState,
  SENTRY_TEST_FORM_ID,
} from "#templates/admin/debug.tsx";
import type { PaymentProviderType } from "#types";

/* jscpd:ignore-end */

type CertValidation = {
  signingCert: string;
  signingKey: string;
  wwdrCert: string;
};

const CERT_STATUS = {
  invalidPem: "Invalid PEM",
  notSet: "Not set",
  valid: "Valid",
} as const;

/** Debug fields use an empty cell when a setting has no value to display. */
const EMPTY_DEBUG_VALUE = "";

const showOrEmpty = (value: string | null | undefined): string =>
  typeof value === "string" ? value : EMPTY_DEBUG_VALUE;

const appleSigningStatus = (
  valid: boolean,
  bothValid: boolean,
  pairMatches: boolean,
  mismatchKey: string,
): string => {
  if (!valid) return CERT_STATUS.invalidPem;
  if (!bothValid || pairMatches) return CERT_STATUS.valid;
  return t(mismatchKey);
};

/** Report whether each Apple Wallet certificate and key is usable together. */
const validateAppleWalletCerts = async (
  config: typeof settings.appleWallet.config,
): Promise<CertValidation> => {
  if (!config) {
    return {
      signingCert: CERT_STATUS.notSet,
      signingKey: CERT_STATUS.notSet,
      wwdrCert: CERT_STATUS.notSet,
    };
  }

  const [signingCertValid, signingKeyValid, wwdrCertValid] = await Promise.all([
    isValidAppleCertificate(config.signingCert),
    isValidRsaPrivateKey(config.signingKey),
    isValidCertificate(config.wwdrCert),
  ]);
  const bothValid = signingCertValid && signingKeyValid;
  const pairMatches =
    bothValid &&
    (await isValidAppleSigningPair(config.signingCert, config.signingKey));
  return {
    signingCert: appleSigningStatus(
      signingCertValid,
      bothValid,
      pairMatches,
      "debug.apple_signing_cert_mismatch",
    ),
    signingKey: appleSigningStatus(
      signingKeyValid,
      bothValid,
      pairMatches,
      "debug.apple_signing_key_mismatch",
    ),
    wwdrCert: wwdrCertValid ? CERT_STATUS.valid : CERT_STATUS.invalidPem,
  };
};

/** Resolve a wallet (apple or google) "source" label from its flags. */
const resolveWalletSource = (
  hasDbConfig: boolean,
  envConfigured: boolean,
): string => {
  if (hasDbConfig) return "Database";
  if (envConfigured) return "Environment variables";
  return EMPTY_DEBUG_VALUE;
};

/** Resolve the effective Apple Wallet pass-type id (db config takes priority). */
const resolveWalletPassTypeId = (
  appleWallet: typeof settings.appleWallet,
): string => {
  if (appleWallet.hasDbConfig) return appleWallet.passTypeId;
  if (appleWallet.hostConfig) return appleWallet.hostConfig.passTypeId;
  return EMPTY_DEBUG_VALUE;
};

/** Resolve the effective Google Wallet issuer id (db config takes priority). */
const resolveGoogleWalletIssuerId = (
  googleWallet: typeof settings.googleWallet,
): string => {
  if (googleWallet.hasDbConfig) return googleWallet.issuerId;
  if (googleWallet.hostConfig) return googleWallet.hostConfig.issuerId;
  return EMPTY_DEBUG_VALUE;
};

/** Validate the Google private key, returning a status string for the UI. */
const validateGooglePrivateKey = async (
  config: typeof settings.googleWallet.config,
): Promise<string> => {
  if (!config) return CERT_STATUS.notSet;
  return (await isValidRsaPrivateKey(config.serviceAccountKey))
    ? CERT_STATUS.valid
    : "Invalid key";
};

/** Whether the configured payment provider has its webhook config set. */
const webhookConfiguredFor = (
  provider: PaymentProviderType | null,
): boolean => {
  const configured = providerValue(provider, {
    square: settings.square.webhookSignatureKey !== EMPTY_DEBUG_VALUE,
    stripe: settings.stripe.webhookEndpointId !== EMPTY_DEBUG_VALUE,
    sumup: settings.sumup.hasKey,
  });
  return configured === true;
};

/** The word shown for each estate a provider's stored credentials can point
 * at. The estate itself is read once, by `paymentProviderMode`. */
const PAYMENT_MODE_LABELS: Record<PaymentProviderMode, string> = {
  live: "Live",
  sandbox: "Sandbox",
  test: "Test",
  unknown: EMPTY_DEBUG_VALUE,
};

/** The active provider's estate, for display. Never exposes the key itself. */
const resolvePaymentMode = (provider: PaymentProviderType | null): string =>
  provider === null
    ? EMPTY_DEBUG_VALUE
    : PAYMENT_MODE_LABELS[paymentProviderMode(provider)];

/** Resolve the site's write-access state from the read-only env flags. */
const resolveAvailabilityState =
  (): DebugPageState["availability"]["state"] => {
    if (isReadOnly()) return "readonly";
    if (isReadOnlyWarning()) return "warning";
    return "active";
  };

/** Gather debug state concurrently */
const getDebugPageState = async (): Promise<DebugPageState> => {
  const bunnyCdnEnabled = isBunnyCdnEnabled();
  const bunnyCdnResult = bunnyCdnEnabled ? await getCdnHostname() : null;
  const bunnyCdnCdnHostname = bunnyCdnResult?.ok
    ? bunnyCdnResult.hostname
    : EMPTY_DEBUG_VALUE;

  const hostEmailConfig = getHostEmailConfig();
  const appleWalletEnvConfigured = settings.appleWallet.hostConfig !== null;
  const googleWalletEnvConfigured = settings.googleWallet.hostConfig !== null;
  const paymentProvider = settings.paymentProvider;
  const dbUrl = getEnv("DB_URL");

  return {
    appleWallet: {
      certValidation: await validateAppleWalletCerts(
        settings.appleWallet.config,
      ),
      dbConfigured: settings.appleWallet.hasDbConfig,
      envConfigured: appleWalletEnvConfigured,
      passTypeId: resolveWalletPassTypeId(settings.appleWallet),
      source: resolveWalletSource(
        settings.appleWallet.hasDbConfig,
        appleWalletEnvConfigured,
      ),
    },
    availability: {
      cutoff: showOrEmpty(getReadOnlyCutoffIso()),
      renewalConfigured: getRenewalUrl() !== null,
      serverTime: nowIso(),
      state: resolveAvailabilityState(),
    },
    build: {
      commit: BUILD_COMMIT,
      timestamp: BUILD_TIMESTAMP,
    },
    bunny: {
      cdnEnabled: bunnyCdnEnabled,
      cdnHostname: bunnyCdnCdnHostname,
      customDomain: bunnyCdnEnabled ? settings.customDomain : EMPTY_DEBUG_VALUE,
      dnsEnabled: isBunnyDnsEnabled(),
      registeredSubdomain: settings.bunnySubdomain,
      storageBackend: getStorageBackend(),
      subdomainSuffix: getBunnyDnsSubdomainSuffix(),
    },
    database: {
      host: dbUrl === undefined ? null : databaseHostFor(dbUrl),
      hostConfigured: dbUrl !== undefined,
      schemaHash: SCHEMA_HASH,
      schemaInSync: settings.getCachedRaw("db_schema_hash") === SCHEMA_HASH,
    },
    domain: getEffectiveDomain(),
    email: {
      apiKeyConfigured: settings.email.hasApiKey,
      fromAddress: settings.email.fromAddress,
      hostProvider: showOrEmpty(hostEmailConfig?.provider),
      provider: settings.email.provider,
    },
    googleWallet: {
      dbConfigured: settings.googleWallet.hasDbConfig,
      envConfigured: googleWalletEnvConfigured,
      issuerId: resolveGoogleWalletIssuerId(settings.googleWallet),
      privateKeyValid: await validateGooglePrivateKey(
        settings.googleWallet.config,
      ),
      source: resolveWalletSource(
        settings.googleWallet.hasDbConfig,
        googleWalletEnvConfigured,
      ),
    },
    limits: LIMIT_ENTRIES,
    notifications: {
      ntfyConfigured: !!getEnv("NTFY_URL"),
      sentryConfigured: !!getEnv("SENTRY_URL"),
    },
    payment: {
      keyConfigured: isPaymentsEnabled(),
      mode: resolvePaymentMode(paymentProvider),
      provider: showOrEmpty(paymentProvider),
      webhookConfigured: webhookConfiguredFor(paymentProvider),
    },
    runtime: getRuntimeInfo(),
    site: {
      bookingFee: settings.bookingFee,
      contactForm: settings.contactFormEnabled,
      country: settings.country,
      currency: settings.currency,
      publicApi: settings.showPublicApi,
      publicSite: settings.features.site,
      spamProtection: isBotpoisonEnabled(),
      timezone: settings.timezone,
    },
    theme: settings.theme,
  };
};

/**
 * Handle GET /admin/debug - owner only
 */
const handleAdminDebugGet: TypedRouteHandler<"GET /admin/debug"> = ownerPage(
  async (session) => {
    const state = await getDebugPageState();
    return adminDebugPage(session, state);
  },
);

/** Send an owner-requested Sentry test and report whether it was delivered. */
const handleSentryTestPost: TypedRouteHandler<"POST /admin/debug/sentry"> =
  gatedPost(OWNER_FORM)(async () => {
    const sent = await sendSentryTest();
    return sent
      ? ok("/admin/debug", t("debug.sentry_test_sent"), {
          formId: SENTRY_TEST_FORM_ID,
        })
      : fail("/admin/debug", t("debug.sentry_test_failed"), {
          formId: SENTRY_TEST_FORM_ID,
        });
  });

/** Debug routes */
export const adminHandlers = defineRoutes({
  "GET /admin/debug": handleAdminDebugGet,
  "POST /admin/debug/sentry": handleSentryTestPost,
});
