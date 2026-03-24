/**
 * Admin guide route
 */

import { settings } from "#lib/db/settings.ts";
import { EMAIL_PROVIDER_LABELS, getHostEmailConfig } from "#lib/email.ts";
import { defineRoutes } from "#routes/router.ts";
import { htmlResponse, requireSessionOr } from "#routes/utils.ts";
import { adminGuidePage } from "#templates/admin/guide.tsx";

/**
 * Handle GET /admin/guide
 */
const handleAdminGuideGet = (request: Request): Promise<Response> =>
  requireSessionOr(request, (session) => {
    const hostEmail = getHostEmailConfig();
    const hostWallet = settings.appleWallet.getHostConfig();
    return htmlResponse(
      adminGuidePage(session, {
        hostEmailProvider: hostEmail
          ? EMAIL_PROVIDER_LABELS[hostEmail.provider]
          : null,
        hostEmailFromAddress: hostEmail?.fromAddress ?? null,
        hostAppleWalletPassTypeId: hostWallet?.passTypeId ?? null,
      }),
    );
  });

/** Guide routes */
export const guideRoutes = defineRoutes({
  "GET /admin/guide": handleAdminGuideGet,
});
