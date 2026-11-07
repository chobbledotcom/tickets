import { defineAdminRoutes } from "#routes/admin/route-tables.ts";
/**
 * Admin Support page routes — let the site operator message the platform host.
 *
 * Available only when ADMIN_EMAIL_ADDRESS is configured (the env var that also
 * powers the superuser system). Owner-only, matching the superuser feature it
 * is tied to. The page shows the host's SUPPORT_PAGE_TEXT and, when a business
 * email exists, a message form that delivers to the host.
 */

import { addPageImageUrls } from "#db/image-urls.ts";
import { t } from "#i18n";
import { formPolicyFor, formPost } from "#routes/auth.ts";
import { requireMessageField } from "#routes/csrf.ts";
import {
  adminRedirect,
  htmlResponse,
  notFoundResponse,
} from "#routes/response.ts";
import { authResponsePageAt } from "#routes/route-gates.ts";
import { adminDestinationAt, adminPattern } from "#shared/admin-surface.ts";
import type { FormParams } from "#shared/form-data.ts";
import { MESSAGE_SEND_FAILED } from "#shared/inbound-message.ts";
import {
  getSupportPageText,
  isSupportEnabled,
  isSupportFormActive,
  recordSupportSubmission,
  sendSupportMessage,
  supportNagLabel,
} from "#shared/support.ts";
import { adminSupportPage } from "#templates/admin/support.tsx";

const SUPPORT_PATH = adminPattern("support");

/** GET /admin/support — render the support page (404 when the feature is off). */
const handleSupportGet = authResponsePageAt(SUPPORT_PATH)(
  async (session, _request, flash) => {
    if (!isSupportEnabled()) return notFoundResponse();
    const supportText = getSupportPageText();
    await addPageImageUrls([supportText]);
    return htmlResponse(
      adminSupportPage({
        error: flash.error,
        formActive: isSupportFormActive(),
        nagLabel: supportNagLabel(),
        session,
        success: flash.success,
        supportText,
      }),
    );
  },
);

/** Validate the message, deliver to the host (from the site's business email),
 * then record the submission for the nag. The endpoint 404s when the form is
 * not active, so it only exists when configured. Support always comes from
 * the site's own business email. The submitter's address is not read. */
const submitSupportMessage = async (form: FormParams): Promise<Response> => {
  if (!isSupportFormActive()) return notFoundResponse();
  const message = requireMessageField(form, SUPPORT_PATH);
  if (message instanceof Response) return message;
  const sent = await sendSupportMessage(message);
  if (!sent) return adminRedirect("support", {}, MESSAGE_SEND_FAILED, false);
  await recordSupportSubmission();
  return adminRedirect("support", {}, t("support.message_sent"), true);
};

/** POST /admin/support — owner-only, CSRF-checked support message. */
const handleSupportPost = formPost(
  formPolicyFor(adminDestinationAt("/admin/support")),
)(submitSupportMessage);

/** Support routes */
export const adminHandlers = defineAdminRoutes({
  "GET /admin/support": handleSupportGet,
  "POST /admin/support": handleSupportPost,
});
