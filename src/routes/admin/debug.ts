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

  const appleWalletDbConfigured = settings.appleWallet.hasDbConfig;
  const appleWalletPassTypeId = settings.appleWallet.passTypeId;
  const appleWalletConfig = settings.appleWallet.config;
  const googleWalletDbConfigured = settings.googleWallet.hasDbConfig;
  const googleWalletIssuerId = settings.googleWallet.issuerId;
  const googleWalletConfig = settings.googleWallet.config;
  const paymentProvider = settings.paymentProvider;
  const stripeKeyConfigured = settings.stripe.hasKey;
  const squareTokenConfigured = settings.square.hasToken;
  const stripeWebhookEndpointId = settings.stripe.webhookEndpointId;
  const squareWebhookKey = settings.square.webhookSignatureKey;
  const emailProvider = settings.email.provider;
  const emailApiKeyConfigured = settings.email.hasApiKey;
  const emailFromAddress = settings.email.fromAddress;
  const customDomain = bunnyCdnEnabled ? settings.customDomain : null;
  const theme = settings.theme;

  const appleWalletEnvConfigured = settings.appleWallet.hostConfig !== null;
  const googleWalletEnvConfigured = settings.googleWallet.hostConfig !== null;
  const hostEmailConfig = getHostEmailConfig();

  const keyConfigured =
    paymentProvider === "stripe"
      ? stripeKeyConfigured
      : paymentProvider === "square"
        ? squareTokenConfigured
        : false;

  const webhookConfigured =
    paymentProvider === "stripe"
      ? stripeWebhookEndpointId !== null
      : paymentProvider === "square"
        ? squareWebhookKey !== null
        : false;

  const resolveWalletPassTypeId = (): string => {
    if (appleWalletDbConfigured) return appleWalletPassTypeId as string;
    if (appleWalletEnvConfigured)
      return settings.appleWallet.hostConfig!.passTypeId;
    return "";
  };
  const resolveWalletSource = (): string => {
    if (appleWalletDbConfigured) return "Database";
    if (appleWalletEnvConfigured) return "Environment variables";
    return "";
  };
  const walletPassTypeId = resolveWalletPassTypeId();
  const walletSource = resolveWalletSource();

  const certValidation = validateAppleWalletCerts(appleWalletConfig);

  const resolveGoogleWalletIssuerId = (): string => {
    if (googleWalletDbConfigured) return googleWalletIssuerId as string;
    if (googleWalletEnvConfigured)
      return settings.googleWallet.hostConfig!.issuerId;
    return "";
  };
  const resolveGoogleWalletSource = (): string => {
    if (googleWalletDbConfigured) return "Database";
    if (googleWalletEnvConfigured) return "Environment variables";
    return "";
  };
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
      dbConfigured: appleWalletDbConfigured,
      envConfigured: appleWalletEnvConfigured,
      passTypeId: walletPassTypeId,
      source: walletSource,
      certValidation,
    },
    googleWallet: {
      dbConfigured: googleWalletDbConfigured,
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
      provider: emailProvider ?? "",
      apiKeyConfigured: emailApiKeyConfigured,
      fromAddress: emailFromAddress ?? "",
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
      customDomain: customDomain ?? "",
    },
    database: {
      hostConfigured: !!getEnv("DB_URL"),
    },
    domain: getEffectiveDomain(),
    limits: LIMIT_ENTRIES,
    theme,
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
