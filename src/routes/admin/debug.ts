/**
 * Admin debug route - shows configuration status for troubleshooting
 * Owner-only access enforced via requireOwnerOr
 */

import {
  isValidPemCertificate,
  isValidPemPrivateKey,
} from "#lib/apple-wallet.ts";
import { BUILD_COMMIT, BUILD_TIMESTAMP } from "#lib/build-info.ts";
import {
  getCdnHostname,
  getEffectiveDomain,
  isBunnyCdnEnabled,
} from "#lib/config.ts";
import { settings } from "#lib/db/settings.ts";
import { getHostEmailConfig } from "#lib/email.ts";
import { getEnv } from "#lib/env.ts";
import { isValidGooglePrivateKey } from "#lib/google-wallet.ts";
import { LIMIT_ENTRIES } from "#lib/limits.ts";
import { isStorageEnabled } from "#lib/storage.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { htmlResponse, requireOwnerOr } from "#routes/utils.ts";
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
      ? settings.stripe.webhookEndpointId !== null
      : paymentProvider === "square"
        ? settings.square.webhookSignatureKey !== null
        : false;

  const resolveWalletPassTypeId = (): string => {
    if (settings.appleWallet.hasDbConfig)
      return settings.appleWallet.passTypeId as string;
    if (appleWalletEnvConfigured)
      return settings.appleWallet.hostConfig!.passTypeId;
    return "";
  };
  const resolveWalletSource = (): string => {
    if (settings.appleWallet.hasDbConfig) return "Database";
    if (appleWalletEnvConfigured) return "Environment variables";
    return "";
  };

  const resolveGoogleWalletIssuerId = (): string => {
    if (settings.googleWallet.hasDbConfig)
      return settings.googleWallet.issuerId as string;
    if (googleWalletEnvConfigured)
      return settings.googleWallet.hostConfig!.issuerId;
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
    build: {
      timestamp: BUILD_TIMESTAMP,
      commit: BUILD_COMMIT,
    },
    appleWallet: {
      dbConfigured: settings.appleWallet.hasDbConfig,
      envConfigured: appleWalletEnvConfigured,
      passTypeId: resolveWalletPassTypeId(),
      source: resolveWalletSource(),
      certValidation: validateAppleWalletCerts(settings.appleWallet.config),
    },
    googleWallet: {
      dbConfigured: settings.googleWallet.hasDbConfig,
      envConfigured: googleWalletEnvConfigured,
      issuerId: resolveGoogleWalletIssuerId(),
      source: resolveGoogleWalletSource(),
      privateKeyValid: googleWalletPrivateKeyValid,
    },
    payment: {
      provider: paymentProvider ?? "",
      keyConfigured,
      webhookConfigured,
    },
    email: {
      provider: settings.email.provider ?? "",
      apiKeyConfigured: settings.email.hasApiKey,
      fromAddress: settings.email.fromAddress ?? "",
      hostProvider: hostEmailConfig?.provider ?? "",
    },
    ntfy: {
      configured: !!getEnv("NTFY_URL"),
    },
    storage: {
      enabled: isStorageEnabled(),
    },
    bunnyCdn: {
      enabled: bunnyCdnEnabled,
      cdnHostname: bunnyCdnEnabled ? getCdnHostname() : "",
      customDomain: (bunnyCdnEnabled ? settings.customDomain : null) ?? "",
    },
    database: {
      hostConfigured: !!getEnv("DB_URL"),
    },
    domain: getEffectiveDomain(),
    limits: LIMIT_ENTRIES,
    theme: settings.theme,
  };
};

/**
 * Handle GET /admin/debug - owner only
 */
const handleAdminDebugGet: TypedRouteHandler<"GET /admin/debug"> = (request) =>
  requireOwnerOr(request, async (session) => {
    const state = await getDebugPageState();
    return htmlResponse(adminDebugPage(session, state));
  });

/** Debug routes */
export const debugRoutes = defineRoutes({
  "GET /admin/debug": handleAdminDebugGet,
});
