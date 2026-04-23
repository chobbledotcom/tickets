/**
 * Admin debug route - shows configuration status for troubleshooting
 * Owner-only access enforced via requireOwnerOr
 */

import {
  isValidPemCertificate,
  isValidPemPrivateKey,
} from "#lib/apple-wallet.ts";
import { BUILD_COMMIT, BUILD_TIMESTAMP } from "#lib/build-info.ts";
import { getCdnHostname } from "#lib/bunny-cdn.ts";
import {
  getBunnyDnsSubdomainSuffix,
  getEffectiveDomain,
  isBunnyCdnEnabled,
  isBunnyDnsEnabled,
} from "#lib/config.ts";
import { settings } from "#lib/db/settings.ts";
import { getHostEmailConfig } from "#lib/email.ts";
import { getEnv } from "#lib/env.ts";
import { isValidGooglePrivateKey } from "#lib/google-wallet.ts";
import { LIMIT_ENTRIES } from "#lib/limits.ts";
import { getStorageBackend } from "#lib/storage.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { ownerPage } from "#routes/auth.ts";
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

/** Gather debug state concurrently */
const getDebugPageState = async (): Promise<DebugPageState> => {
  const bunnyCdnEnabled = isBunnyCdnEnabled();
  const bunnyCdnResult = bunnyCdnEnabled ? await getCdnHostname() : null;
  const bunnyCdnCdnHostname = bunnyCdnResult?.ok ? bunnyCdnResult.hostname : "";

  const hostEmailConfig = getHostEmailConfig();
  const appleWalletEnvConfigured = settings.appleWallet.hostConfig !== null;
  const googleWalletEnvConfigured = settings.googleWallet.hostConfig !== null;

  const paymentProvider = settings.paymentProvider;
  const keyConfigured =
    paymentProvider === "stripe"
      ? settings.stripe.hasKey
      : paymentProvider === "square"
        ? settings.square.hasToken
        : false;

  const webhookConfigured =
    paymentProvider === "stripe"
      ? settings.stripe.webhookEndpointId !== ""
      : paymentProvider === "square"
        ? settings.square.webhookSignatureKey !== ""
        : false;

  const resolveWalletPassTypeId = (): string => {
    if (settings.appleWallet.hasDbConfig) {
      return settings.appleWallet.passTypeId;
    }
    if (appleWalletEnvConfigured) {
      return settings.appleWallet.hostConfig!.passTypeId;
    }
    return "";
  };
  const resolveWalletSource = (): string => {
    if (settings.appleWallet.hasDbConfig) return "Database";
    if (appleWalletEnvConfigured) return "Environment variables";
    return "";
  };

  const resolveGoogleWalletIssuerId = (): string => {
    if (settings.googleWallet.hasDbConfig) {
      return settings.googleWallet.issuerId;
    }
    if (googleWalletEnvConfigured) {
      return settings.googleWallet.hostConfig!.issuerId;
    }
    return "";
  };
  const resolveGoogleWalletSource = (): string => {
    if (settings.googleWallet.hasDbConfig) return "Database";
    if (googleWalletEnvConfigured) return "Environment variables";
    return "";
  };

  const googleWalletConfig = settings.googleWallet.config;
  const googleWalletPrivateKeyValid = googleWalletConfig
    ? (await isValidGooglePrivateKey(googleWalletConfig.serviceAccountKey))
      ? "Valid"
      : "Invalid key"
    : "Not set";

  return {
    appleWallet: {
      certValidation: validateAppleWalletCerts(settings.appleWallet.config),
      dbConfigured: settings.appleWallet.hasDbConfig,
      envConfigured: appleWalletEnvConfigured,
      passTypeId: resolveWalletPassTypeId(),
      source: resolveWalletSource(),
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
      issuerId: resolveGoogleWalletIssuerId(),
      privateKeyValid: googleWalletPrivateKeyValid,
      source: resolveGoogleWalletSource(),
    },
    limits: LIMIT_ENTRIES,
    ntfy: {
      configured: !!getEnv("NTFY_URL"),
    },
    payment: {
      keyConfigured,
      provider: paymentProvider ?? "",
      webhookConfigured,
    },
    prune: {
      logins: formatLastPruned(settings.lastPrunedLogins),
      payments: formatLastPruned(settings.lastPrunedPayments),
      sessions: formatLastPruned(settings.lastPrunedSessions),
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
