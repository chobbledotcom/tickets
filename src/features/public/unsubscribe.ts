/**
 * Public unsubscribe / resubscribe routes for marketing emails.
 *
 * The link carries an opaque email hash (HMAC), so the address is never
 * exposed and state only changes via POST. No login required — recipients act
 * on their own address via the capability in their link.
 */

import { applyFlash, withCsrfForm } from "#routes/csrf.ts";
import { htmlResponse, redirect } from "#routes/response.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  isHashUnsubscribed,
  resubscribeHash,
  unsubscribeHash,
} from "#shared/db/unsubscribes.ts";
import { unsubscribePage } from "#templates/public/unsubscribe.tsx";

const pagePath = (hash: string): string =>
  `/unsubscribe?email=${encodeURIComponent(hash)}`;

/** GET /unsubscribe?email=<hash> — show current status and the toggle form. */
export const handleUnsubscribeGet = async (
  request: Request,
): Promise<Response> => {
  const flash = applyFlash(request);
  await signCsrfToken();
  const hash = new URL(request.url).searchParams.get("email");
  const unsubscribed = hash ? await isHashUnsubscribed(hash) : false;
  return htmlResponse(
    unsubscribePage({
      error: flash.error,
      hash,
      success: flash.success,
      unsubscribed,
    }),
  );
};

/** POST /unsubscribe — toggle subscription state for the link's hash. */
export const handleUnsubscribePost = (request: Request): Promise<Response> =>
  withCsrfForm(
    request,
    (message, status) =>
      htmlResponse(
        unsubscribePage({ error: message, hash: null, unsubscribed: false }),
        status,
      ),
    async (form) => {
      const hash = form.getString("email");
      if (!hash) {
        return redirect("/unsubscribe", "That link is invalid.", false);
      }
      if (form.getString("action") === "resubscribe") {
        await resubscribeHash(hash);
        return redirect(
          pagePath(hash),
          "You've resubscribed to our marketing emails.",
          true,
        );
      }
      await unsubscribeHash(hash);
      return redirect(
        pagePath(hash),
        "You've unsubscribed from our marketing emails.",
        true,
      );
    },
  );
