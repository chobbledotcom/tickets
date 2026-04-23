/**
 * Admin guide route
 */

import { getBunnyDnsSubdomainSuffix, isBunnyDnsEnabled } from "#lib/config.ts";
import { settings } from "#lib/db/settings.ts";
import { EMAIL_PROVIDER_LABELS, getHostEmailConfig } from "#lib/email.ts";
import { isBuilderEnabled } from "#routes/admin/builder.ts";
import { defineRoutes } from "#routes/router.ts";
import { sessionPage } from "#routes/auth.ts";
import { adminGuidePage } from "#templates/admin/guide.tsx";

/**
 * Handle GET /admin/guide
 */
const handleAdminGuideGet = sessionPage((session) => {
  const hostEmail = getHostEmailConfig();
  return adminGuidePage(session, {
    builderEnabled: isBuilderEnabled(),
    bunnyDnsSubdomainSuffix: isBunnyDnsEnabled()
      ? getBunnyDnsSubdomainSuffix()
      : null,
    hostAppleWalletPassTypeId:
      settings.appleWallet.hostConfig?.passTypeId ?? null,
    hostEmailFromAddress: hostEmail?.fromAddress ?? null,
    hostEmailProvider: hostEmail
      ? EMAIL_PROVIDER_LABELS[hostEmail.provider]
      : null,
    hostGoogleWalletIssuerId:
      settings.googleWallet.hostConfig?.issuerId ?? null,
  });
});

/** Guide routes */
export const guideRoutes = defineRoutes({
  "GET /admin/guide": handleAdminGuideGet,
});
