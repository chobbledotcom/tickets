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

/** Validate Apple Wallet PEM certs/key, returning "Valid", "Invalid PEM", or "Not set" for each */
const validateAppleWalletCerts = (
  config: Awaited<ReturnType<typeof getAppleWalletConfig>>,
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
    wwdrCert: isValidPemCertificate(config.wwdrCert)
      ? "Valid"
      : "Invalid PEM",
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

  const resolveWalletPassTypeId = (): string => {
    if (appleWalletDbConfigured) return appleWalletPassTypeId as string;
    if (appleWalletEnvConfigured) return getHostAppleWalletConfig()!.passTypeId;
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

  return {
    appleWallet: {
      dbConfigured: appleWalletDbConfigured,
      envConfigured: appleWalletEnvConfigured,
      passTypeId: walletPassTypeId,
      source: walletSource,
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
