/**
 * Admin SMS page — text an attendee via the gateway queue.
 *
 * Reached at `/admin/sms?listing=:id&attendee=:id` (mirroring the email page,
 * with which it will eventually reach parity). The page shows the current
 * queue size and, when an attendee is targeted, a compose form plus the
 * conversation history.
 *
 * The attendee's phone number is decrypted transiently under the owner's
 * session key, immediately re-encrypted under the SMS Gate E2E key, and only
 * that ciphertext is transmitted — plaintext PII is never persisted. History
 * lives in the (encrypted) activity log; the sms_messages table only maps
 * gateway ids to attendees for status webhooks.
 */

import {
  AUTH_FORM,
  type AuthSession,
  requireSessionOr,
  withAuth,
} from "#routes/auth.ts";
import { htmlResponse, redirect } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { getSearchParam } from "#routes/url.ts";
import { getAttendeeActivityLog, logActivity } from "#shared/db/activityLog.ts";
import { setAttendeePhoneIndexIfEmpty } from "#shared/db/attendee-phone-index.ts";
import { hashPhone, recordContacts } from "#shared/db/contact-preferences.ts";
import { countSmsMessages, recordSmsMessage } from "#shared/db/sms-messages.ts";
import { getFlash } from "#shared/flash-context.ts";
import type { FormParams } from "#shared/form-data.ts";
import { bestEffort } from "#shared/logger.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import {
  buildMessagePayload,
  getSmsGatewayConfig,
  sendEncryptedMessage,
} from "#shared/sms/gateway.ts";
import { computePhoneIndex } from "#shared/sms/phone-index.ts";
import { parsePositiveIntId } from "#shared/validation/number.ts";
import { type SmsHistoryItem, smsPage } from "#templates/admin/sms.tsx";
import { withAttendee } from "./attendees-route-helpers.ts";

/** SMS-related activity-log entries all start with this. */
const SMS_LOG_PREFIX = "SMS";

const smsUrl = (listingId: number, attendeeId: number): string =>
  `/admin/sms?listing=${listingId}&attendee=${attendeeId}`;

/** Conversation history for an attendee, read from the activity log. */
const historyFor = async (attendeeId: number): Promise<SmsHistoryItem[]> =>
  (await getAttendeeActivityLog(attendeeId))
    .filter((e) => e.message.startsWith(SMS_LOG_PREFIX))
    .map((e) => ({ created: e.created, message: e.message }));

/** GET /admin/sms */
const handleSmsGet = (request: Request): Promise<Response> =>
  requireSessionOr(request, async (session) => {
    const listingId = parsePositiveIntId(getSearchParam(request, "listing"));
    const attendeeId = parsePositiveIntId(getSearchParam(request, "attendee"));
    const flash = getFlash();
    const queueCount = await countSmsMessages();
    const configured = getSmsGatewayConfig() !== null;

    if (listingId === null || attendeeId === null) {
      return htmlResponse(
        smsPage(session, { configured, flash, history: [], queueCount }),
      );
    }

    return withAttendee(
      listingId,
      attendeeId,
    )(async (data) =>
      htmlResponse(
        smsPage(session, {
          configured,
          flash,
          history: await historyFor(attendeeId),
          queueCount,
          target: data,
        }),
      ),
    );
  });

/** Send the composed text to the targeted attendee. */
const sendSms = (
  _session: AuthSession,
  form: FormParams,
): Promise<Response> => {
  const listingId = parsePositiveIntId(form.getString("listing"));
  const attendeeId = parsePositiveIntId(form.getString("attendee"));
  if (listingId === null || attendeeId === null) {
    return Promise.resolve(redirect("/admin/sms", "Invalid SMS target", false));
  }
  const backUrl = smsUrl(listingId, attendeeId);

  return withAttendee(
    listingId,
    attendeeId,
  )(async (data) => {
    const config = getSmsGatewayConfig();
    if (!config) {
      return redirect(backUrl, "SMS gateway is not configured", false);
    }

    const message = form.getString("message").trim();
    if (!message) {
      return redirect(backUrl, "Message cannot be empty", false);
    }

    const phone = data.attendee.phone.trim();
    if (!phone) {
      return redirect(backUrl, "Attendee has no phone number on file", false);
    }

    // Record a blind-index of the number so inbound replies can be matched
    // back to this attendee (lazy, set once).
    await setAttendeePhoneIndexIfEmpty(
      attendeeId,
      await computePhoneIndex(phone),
    );

    const payload = await buildMessagePayload(
      phone,
      message,
      config.passphrase,
    );

    try {
      const { providerId } = await sendEncryptedMessage(config, payload);
      await recordSmsMessage({ attendeeId, listingId, providerId });
      // Count the text against this phone contact so the per-phone history
      // panel's "Total messages" reflects SMS, not just bulk email. Best-effort:
      // the message is already sent, so a contact-history write failure (e.g. an
      // undecryptable stats_blob) must not report the send as failed and prompt
      // the operator to retry — that would deliver a duplicate text.
      await bestEffort("SMS contact-history update", async () =>
        recordContacts(
          [await hashPhone(phone)],
          message,
          await requireRequestPrivateKey(),
        ),
      );
      await logActivity(
        `${SMS_LOG_PREFIX} queued for ${data.attendee.name}: ${message}`,
        listingId,
        attendeeId,
      );
      return redirect(backUrl, "Text message queued", true);
    } catch (e) {
      await logActivity(
        `${SMS_LOG_PREFIX} to ${data.attendee.name} could not be queued: ${String(
          e,
        )}`,
        listingId,
        attendeeId,
      );
      return redirect(backUrl, "Message could not be queued", false);
    }
  });
};

/** POST /admin/sms */
const handleSmsPost = (request: Request): Promise<Response> =>
  withAuth(request, AUTH_FORM, sendSms);

export const smsRoutes = defineRoutes({
  "GET /admin/sms": handleSmsGet,
  "POST /admin/sms": handleSmsPost,
});
