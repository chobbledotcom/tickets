/**
 * Admin attendee "contact" routes — send a text message to an attendee via the
 * SMS gateway.
 *
 * The attendee's phone number is decrypted transiently under the owner's
 * session key, immediately re-encrypted under the SMS Gate E2E key, and only
 * that ciphertext is transmitted — plaintext PII is never persisted. The
 * conversation history lives in the (encrypted) activity log; the sms_messages
 * table only maps gateway ids to attendees for status webhooks.
 */

import { applyFlash } from "#routes/csrf.ts";
import { htmlResponse, redirect } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { getAttendeeActivityLog, logActivity } from "#shared/db/activityLog.ts";
import { setAttendeePhoneIndexIfEmpty } from "#shared/db/attendee-phone-index.ts";
import { recordSmsMessage } from "#shared/db/sms-messages.ts";
import {
  buildMessagePayload,
  getSmsGatewayConfig,
  sendEncryptedMessage,
} from "#shared/sms/gateway.ts";
import { computePhoneIndex } from "#shared/sms/phone-index.ts";
import {
  attendeeContactPage,
  type SmsHistoryItem,
} from "#templates/admin/attendee-contact.tsx";
import {
  attendeeFormAction,
  attendeeGetRoute,
} from "./attendees-route-helpers.ts";

/** SMS-related activity-log entries all start with this. */
const SMS_LOG_PREFIX = "Text message";

/** GET /admin/listing/:listingId/attendee/:attendeeId/contact */
const handleContactGet = attendeeGetRoute(async (data, session, request) => {
  const flash = applyFlash(request);
  const entries = await getAttendeeActivityLog(data.attendee.id);
  const history: SmsHistoryItem[] = entries
    .filter((e) => e.message.startsWith(SMS_LOG_PREFIX))
    .map((e) => ({ created: e.created, message: e.message }));
  return htmlResponse(
    attendeeContactPage(data, session, history, {
      configured: getSmsGatewayConfig() !== null,
      error: flash.error,
      success: flash.success,
    }),
  );
});

/** POST /admin/listing/:listingId/attendee/:attendeeId/contact */
const handleContactPost = attendeeFormAction(
  async (data, _session, form, listingId, attendeeId) => {
    const backUrl = `/admin/listing/${listingId}/attendee/${attendeeId}/contact`;
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
        `${SMS_LOG_PREFIX} sent to ${data.attendee.name}: ${message}`,
        listingId,
        attendeeId,
      );
      return redirect(backUrl, "Text message sent", true);
    } catch (e) {
      await logActivity(
        `${SMS_LOG_PREFIX} to ${data.attendee.name} failed to send: ${String(e)}`,
        listingId,
        attendeeId,
      );
      return redirect(backUrl, "Message failed to send", false);
    }
  },
);

export const attendeeContactRoutes = defineRoutes({
  "GET /admin/listing/:listingId/attendee/:attendeeId/contact":
    handleContactGet,
  "POST /admin/listing/:listingId/attendee/:attendeeId/contact":
    handleContactPost,
});
