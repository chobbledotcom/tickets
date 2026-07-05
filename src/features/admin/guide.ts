/**
 * Admin guide route
 */

import { isBuilderEnabled } from "#routes/admin/builder.ts";
import { contentPage, sessionPage } from "#routes/auth.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  getBunnyDnsSubdomainSuffix,
  isBunnyDnsEnabled,
} from "#shared/config.ts";
import { settings } from "#shared/db/settings.ts";
import { EMAIL_PROVIDER_LABELS, getHostEmailConfig } from "#shared/email.ts";
import {
  adminFormattingHelpPage,
  adminGuidePage,
} from "#templates/admin/guide.tsx";

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

/**
 * Handle GET /admin/formatting — the markdown formatting help linked from
 * markdown field hints. Content roles (incl. editors) may open it; it shows only
 * the editor-safe Text Formatting section, never the full staff guide.
 */
const handleAdminFormattingGet = contentPage((session) =>
  adminFormattingHelpPage(session),
);

/** Guide routes */
export const guideRoutes = defineRoutes({
  "GET /admin/formatting": handleAdminFormattingGet,
  "GET /admin/guide": handleAdminGuideGet,
});
