/**
 * Admin Support page routes — let the site operator message the platform host.
 *
 * Available only when ADMIN_EMAIL_ADDRESS is configured (the env var that also
 * powers the superuser system). Owner-only, matching the superuser feature it
 * is tied to. The page shows the host's SUPPORT_PAGE_TEXT and, when a business
 * email exists, a message form that delivers to the host.
 */

import { OWNER_FORM, requireOwnerOr, withAuth } from "#routes/auth.ts";
import { requireMessageField } from "#routes/csrf.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { settings } from "#shared/db/settings.ts";
import { getFlash } from "#shared/flash-context.ts";
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

const SUPPORT_PATH = "/admin/support";

/** GET /admin/support — render the support page (404 when the feature is off). */
const handleSupportGet = (request: Request): Promise<Response> =>
  requireOwnerOr(request, (session) => {
    if (!isSupportEnabled()) return notFoundResponse();
    const flash = getFlash();
    return htmlResponse(
      adminSupportPage({
        businessEmail: settings.businessEmail,
        error: flash.error,
        formActive: isSupportFormActive(),
        nagLabel: supportNagLabel(),
        session,
        success: flash.success,
        supportText: getSupportPageText(),
      }),
    );
  });

/** Validate the message, deliver to the host (from the site's business email),
 * then record the submission for the nag. 404s when the form is not active so
 * the endpoint only exists when configured. The submitter's address isn't read:
 * support always comes from the site's own business email. */
const submitSupportMessage = async (form: FormParams): Promise<Response> => {
  if (!isSupportFormActive()) return notFoundResponse();
  const message = requireMessageField(form, SUPPORT_PATH);
  if (message instanceof Response) return message;
  const sent = await sendSupportMessage(message);
  if (!sent) return errorRedirect(SUPPORT_PATH, MESSAGE_SEND_FAILED);
  await recordSupportSubmission();
  return redirect(SUPPORT_PATH, "Your message has been sent", true);
};

/** POST /admin/support — owner-only, CSRF-checked support message. */
const handleSupportPost = (request: Request): Promise<Response> =>
  withAuth(request, OWNER_FORM, (_session, form) => submitSupportMessage(form));

/** Support routes */
export const supportRoutes = defineRoutes({
  "GET /admin/support": handleSupportGet,
  "POST /admin/support": handleSupportPost,
});
