/**
 * Admin debug route - shows configuration status for troubleshooting
 * Owner-only access enforced via requireOwnerOr
 */

import { ownerPage } from "#routes/auth.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import {
  isValidPemCertificate,
  isValidPemPrivateKey,
} from "#shared/apple-wallet.ts";
import { BUILD_COMMIT, BUILD_TIMESTAMP } from "#shared/build-info.ts";
import { getCdnHostname } from "#shared/bunny-cdn.ts";
import {
  getBunnyDnsSubdomainSuffix,
  getEffectiveDomain,
  isBotpoisonEnabled,
  isBunnyCdnEnabled,
  isBunnyDnsEnabled,
  isPaymentsEnabled,
} from "#shared/config.ts";
import { SCHEMA_HASH } from "#shared/db/migrations.ts";
import { settings } from "#shared/db/settings.ts";
import { getHostEmailConfig } from "#shared/email.ts";
import {
  getEnv,
  getReadOnlyCutoffIso,
  getRenewalUrl,
  isReadOnly,
  isReadOnlyWarning,
} from "#shared/env.ts";
import { isValidGooglePrivateKey } from "#shared/google-wallet.ts";
import { LIMIT_ENTRIES } from "#shared/limits.ts";
import { nowIso } from "#shared/now.ts";
import { getRuntimeInfo } from "#shared/runtime.ts";
import { getStorageBackend } from "#shared/storage.ts";
import {
  adminDebugPage,
  type DebugPageState,
} from "#templates/admin/debug.tsx";

type CertValidation = {
  signingCert: string;
  signingKey: string;
  wwdrCert: string;
};

/** Validate Apple Wallet PEM certs/key, returning "Valid", "Invalid PEM", or "Not set" for each */
const validateAppleWalletCerts = (
  config: typeof settings.appleWallet.config,
): CertValidation => {
  if (!config) {
    return {
      signingCert: "Not set",
      signingKey: "Not set",
      wwdrCert: "Not set",
    };
  }

  return {
    signingCert: isValidPemCertificate(config.signingCert)
      ? "Valid"
      : "Invalid PEM",
    signingKey: isValidPemPrivateKey(config.signingKey)
      ? "Valid"
      : "Invalid PEM",
    wwdrCert: isValidPemCertificate(config.wwdrCert) ? "Valid" : "Invalid PEM",
  };
};

/** Resolve a wallet (apple or google) "source" label from its flags. */
const resolveWalletSource = (
  hasDbConfig: boolean,
  envConfigured: boolean,
): string => {
  if (hasDbConfig) return "Database";
  if (envConfigured) return "Environment variables";
  return "";
};

/** Resolve the effective Apple Wallet pass-type id (db config takes priority). */
const resolveWalletPassTypeId = (
  appleWallet: typeof settings.appleWallet,
): string => {
  if (appleWallet.hasDbConfig) return appleWallet.passTypeId;
  if (appleWallet.hostConfig) return appleWallet.hostConfig.passTypeId;
  return "";
};

/** Resolve the effective Google Wallet issuer id (db config takes priority). */
const resolveGoogleWalletIssuerId = (
  googleWallet: typeof settings.googleWallet,
): string => {
  if (googleWallet.hasDbConfig) return googleWallet.issuerId;
  if (googleWallet.hostConfig) return googleWallet.hostConfig.issuerId;
  return "";
};

/** Validate the Google private key, returning a status string for the UI. */
const validateGooglePrivateKey = async (
  config: typeof settings.googleWallet.config,
): Promise<string> => {
  if (!config) return "Not set";
  return (await isValidGooglePrivateKey(config.serviceAccountKey))
    ? "Valid"
    : "Invalid key";
};

/** Whether the configured payment provider has its webhook config set. */
const webhookConfiguredFor = (provider: string | null): boolean => {
  if (provider === "stripe") return settings.stripe.webhookEndpointId !== "";
  if (provider === "square") return settings.square.webhookSignatureKey !== "";
  if (provider === "sumup") return settings.sumup.hasKey;
  return false;
};

/** Map a `sk_test_`/`sk_live_` key mode to a display label; "" if unrecognized. */
const paymentModeLabel = (mode: "test" | "live" | null): string =>
  mode === "live" ? "Live" : mode === "test" ? "Test" : "";

/**
 * Resolve the active payment provider's environment (Test/Live/Sandbox) for
 * display. Derived from the key prefix (Stripe/SumUp) or the sandbox flag
 * (Square) — never exposes the key itself.
 */
const resolvePaymentMode = (provider: string | null): string => {
  if (provider === "stripe") return paymentModeLabel(settings.stripe.keyMode);
  if (provider === "sumup") return paymentModeLabel(settings.sumup.keyMode);
  if (provider === "square") {
    return settings.square.sandbox ? "Sandbox" : "Live";
  }
  return "";
};

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
  const bunnyCdnCdnHostname = bunnyCdnResult?.ok ? bunnyCdnResult.hostname : "";

  const hostEmailConfig = getHostEmailConfig();
  const appleWalletEnvConfigured = settings.appleWallet.hostConfig !== null;
  const googleWalletEnvConfigured = settings.googleWallet.hostConfig !== null;
  const paymentProvider = settings.paymentProvider;

  return {
    appleWallet: {
      certValidation: validateAppleWalletCerts(settings.appleWallet.config),
      dbConfigured: settings.appleWallet.hasDbConfig,
      envConfigured: appleWalletEnvConfigured,
      passTypeId: resolveWalletPassTypeId(settings.appleWallet),
      source: resolveWalletSource(
        settings.appleWallet.hasDbConfig,
        appleWalletEnvConfigured,
      ),
    },
    availability: {
      cutoff: getReadOnlyCutoffIso() ?? "",
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
      customDomain: bunnyCdnEnabled ? settings.customDomain : "",
      dnsEnabled: isBunnyDnsEnabled(),
      registeredSubdomain: settings.bunnySubdomain,
      storageBackend: getStorageBackend(),
      subdomainSuffix: getBunnyDnsSubdomainSuffix(),
    },
    database: {
      hostConfigured: !!getEnv("DB_URL"),
      schemaHash: SCHEMA_HASH,
      schemaInSync: settings.getCachedRaw("db_schema_hash") === SCHEMA_HASH,
    },
    domain: getEffectiveDomain(),
    email: {
      apiKeyConfigured: settings.email.hasApiKey,
      fromAddress: settings.email.fromAddress,
      hostProvider: hostEmailConfig?.provider ?? "",
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
    ntfy: {
      configured: !!getEnv("NTFY_URL"),
    },
    payment: {
      keyConfigured: isPaymentsEnabled(),
      mode: resolvePaymentMode(paymentProvider),
      provider: paymentProvider ?? "",
      webhookConfigured: webhookConfiguredFor(paymentProvider),
    },
    prune: {
      logins: formatLastPruned(settings.lastPrunedLogins),
      payments: formatLastPruned(settings.lastPrunedPayments),
      sessions: formatLastPruned(settings.lastPrunedSessions),
      strings: formatLastPruned(settings.lastPrunedStrings),
    },
    runtime: getRuntimeInfo(),
    site: {
      bookingFee: settings.bookingFee,
      contactForm: settings.contactFormEnabled,
      country: settings.country,
      currency: settings.currency,
      publicApi: settings.showPublicApi,
      publicSite: settings.showPublicSite,
      spamProtection: isBotpoisonEnabled(),
      timezone: settings.timezone,
    },
    theme: settings.theme,
  };
};

/** Format a stored last-pruned ms-epoch string as ISO.
 * `raw` is always a positive ms-epoch string by the time we render: every
 * incoming request triggers maybeRunPrunes() as pending work, which writes a
 * fresh timestamp before the /admin/debug handler reads the snapshot. */
const formatLastPruned = (raw: string): string =>
  new Date(Number(raw)).toISOString();

/**
 * Handle GET /admin/debug - owner only
 */
const handleAdminDebugGet: TypedRouteHandler<"GET /admin/debug"> = ownerPage(
  async (session) => {
    const state = await getDebugPageState();
    return adminDebugPage(session, state);
  },
);

/** Debug routes */
export const debugRoutes = defineRoutes({
  "GET /admin/debug": handleAdminDebugGet,
});
