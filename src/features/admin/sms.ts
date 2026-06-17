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

import { AUTH_FORM, requireSessionOr, withAuth } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { htmlResponse, notFoundResponse, redirect } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { getSearchParam } from "#routes/url.ts";
import { getAttendeeActivityLog, logActivity } from "#shared/db/activityLog.ts";
import { setAttendeePhoneIndexIfEmpty } from "#shared/db/attendee-phone-index.ts";
import { countSmsMessages, recordSmsMessage } from "#shared/db/sms-messages.ts";
import {
  buildMessagePayload,
  getSmsGatewayConfig,
  sendEncryptedMessage,
} from "#shared/sms/gateway.ts";
import { computePhoneIndex } from "#shared/sms/phone-index.ts";
import { type SmsHistoryItem, smsPage } from "#templates/admin/sms.tsx";
import { loadAttendeeForListing } from "./attendees-route-helpers.ts";

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
    const listingId = Number(getSearchParam(request, "listing"));
    const attendeeId = Number(getSearchParam(request, "attendee"));
    const flash = applyFlash(request);
    const queueCount = await countSmsMessages();
    const configured = getSmsGatewayConfig() !== null;

    if (!listingId || !attendeeId) {
      return htmlResponse(
        smsPage(session, { configured, flash, history: [], queueCount }),
      );
    }

    const data = await loadAttendeeForListing(session, listingId, attendeeId);
    if (!data) return notFoundResponse();

    return htmlResponse(
      smsPage(session, {
        configured,
        flash,
        history: await historyFor(attendeeId),
        queueCount,
        target: data,
      }),
    );
  });

/** POST /admin/sms */
const handleSmsPost = (request: Request): Promise<Response> =>
  withAuth(request, AUTH_FORM, async (session, form) => {
    const listingId = Number(form.getString("listing"));
    const attendeeId = Number(form.getString("attendee"));
    const backUrl = smsUrl(listingId, attendeeId);

    const data = await loadAttendeeForListing(session, listingId, attendeeId);
    if (!data) return notFoundResponse();

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
      await logActivity(
        `${SMS_LOG_PREFIX} queued for ${data.attendee.name}: ${message}`,
        listingId,
        attendeeId,
      );
      return redirect(backUrl, "Text message queued", true);
    } catch (e) {
      await logActivity(
        `${SMS_LOG_PREFIX} to ${data.attendee.name} could not be queued: ${String(e)}`,
        listingId,
        attendeeId,
      );
      return redirect(backUrl, "Message could not be queued", false);
    }
  });

export const smsRoutes = defineRoutes({
  "GET /admin/sms": handleSmsGet,
  "POST /admin/sms": handleSmsPost,
});
