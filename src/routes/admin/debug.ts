/**
 * Admin debug route - shows configuration status for troubleshooting
 * Owner-only access enforced via requireOwnerOr
 */

import {
  isValidPemCertificate,
  isValidPemPrivateKey,
} from "#lib/apple-wallet.ts";
import {
  getAllowedDomain,
  getCdnHostname,
  isBunnyCdnEnabled,
} from "#lib/config.ts";
import {
  getAppleWalletConfig,
  getAppleWalletPassTypeIdFromDb,
  getCustomDomainFromDb,
  getEmailFromAddressFromDb,
  getEmailProviderFromDb,
  getHostAppleWalletConfig,
  getPaymentProviderFromDb,
  getSquareWebhookSignatureKeyFromDb,
  getStripeWebhookEndpointId,
  getThemeFromDb,
  hasAppleWalletDbConfig,
  hasEmailApiKey,
  hasSquareToken,
  hasStripeKey,
} from "#lib/db/settings.ts";
import { getHostEmailConfig } from "#lib/email.ts";
import { getEnv } from "#lib/env.ts";
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

/** Validate Apple Wallet PEM certs/key, returning "Valid", "Invalid", or "Not set" for each */
const validateAppleWalletCerts = (
  config: Awaited<ReturnType<typeof getAppleWalletConfig>>,
): CertValidation => {
  if (!config) return { signingCert: "Not set", signingKey: "Not set", wwdrCert: "Not set" };

  const check = (
    value: string | undefined,
    validator: (pem: string) => boolean,
  ): string => {
    if (!value) return "Not set";
    try {
      return validator(value) ? "Valid" : "Invalid PEM";
    } catch {
      return "Invalid PEM";
    }
  };

  return {
    signingCert: check(config.signingCert, isValidPemCertificate),
    signingKey: check(config.signingKey, isValidPemPrivateKey),
    wwdrCert: check(config.wwdrCert, isValidPemCertificate),
  };
};

/** Gather debug state concurrently */
const getDebugPageState = async (): Promise<DebugPageState> => {
  const bunnyCdnEnabled = isBunnyCdnEnabled();

  const [
    appleWalletDbConfigured,
    appleWalletPassTypeId,
    appleWalletConfig,
    paymentProvider,
    stripeKeyConfigured,
    squareTokenConfigured,
    stripeWebhookEndpointId,
    squareWebhookKey,
    emailProvider,
    emailApiKeyConfigured,
    emailFromAddress,
    customDomain,
    theme,
  ] = await Promise.all([
    hasAppleWalletDbConfig(),
    getAppleWalletPassTypeIdFromDb(),
    getAppleWalletConfig(),
    getPaymentProviderFromDb(),
    hasStripeKey(),
    hasSquareToken(),
    getStripeWebhookEndpointId(),
    getSquareWebhookSignatureKeyFromDb(),
    getEmailProviderFromDb(),
    hasEmailApiKey(),
    getEmailFromAddressFromDb(),
    bunnyCdnEnabled ? getCustomDomainFromDb() : Promise.resolve(null),
    getThemeFromDb(),
  ]);

  const appleWalletEnvConfigured = getHostAppleWalletConfig() !== null;
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

  const appleWalletSource = appleWalletDbConfigured
    ? "Database"
    : appleWalletEnvConfigured
      ? "Environment variables"
      : "";

  const appleWalletPassTypeIdDisplay = appleWalletDbConfigured
    ? (appleWalletPassTypeId ?? "")
    : appleWalletEnvConfigured
      ? (getHostAppleWalletConfig()?.passTypeId ?? "")
      : "";

  const certValidation = validateAppleWalletCerts(appleWalletConfig);

  return {
    appleWallet: {
      dbConfigured: appleWalletDbConfigured,
      envConfigured: appleWalletEnvConfigured,
      passTypeId: appleWalletPassTypeIdDisplay,
      source: appleWalletSource,
      certValidation,
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
    domain: getAllowedDomain(),
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
