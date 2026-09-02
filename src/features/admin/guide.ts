import { defineRoutes } from "#routes/router.ts";

/**
 * Admin guide route
 */

import { settings } from "#db/settings.ts";
import { contentPage, sessionPage } from "#routes/auth.ts";
import {
  getBunnyDnsSubdomainSuffix,
  isBuilderEnabled,
  isBunnyDnsEnabled,
} from "#shared/config.ts";
import { EMAIL_PROVIDER_LABELS, hostEmail } from "#shared/email.ts";
import {
  adminFormattingHelpPage,
  adminGuidePage,
} from "#templates/admin/guide.tsx";

/**
 * Handle GET /admin/guide
 */
const handleAdminGuideGet = sessionPage((session) => {
  const hostEmailConfig = hostEmail.getHostConfig();
  return adminGuidePage(session, {
    builderEnabled: isBuilderEnabled(),
    bunnyDnsSubdomainSuffix: isBunnyDnsEnabled()
      ? getBunnyDnsSubdomainSuffix()
      : null,
    hostAppleWalletPassTypeId:
      settings.appleWallet.hostConfig?.passTypeId ?? null,
    hostEmailFromAddress: hostEmailConfig?.fromAddress ?? null,
    hostEmailProvider: hostEmailConfig
      ? EMAIL_PROVIDER_LABELS[hostEmailConfig.provider]
      : null,
    hostGoogleWalletIssuerId:
      settings.googleWallet.hostConfig?.issuerId ?? null,
  });
});

/**
 * Handle GET /admin/formatting — the markdown formatting help linked from
 * markdown field hints. Content roles (incl. editors) may open it; it shows only
 * the editor-safe Text Formatting section, never the full staff guide.
 */
const handleAdminFormattingGet = contentPage((session) =>
  adminFormattingHelpPage(session),
);

/** Guide routes */
export const adminHandlers = defineRoutes({
  "GET /admin/formatting": handleAdminFormattingGet,
  "GET /admin/guide": handleAdminGuideGet,
});
