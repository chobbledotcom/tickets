/**
 * Admin attendee "contact" routes — send a text message to an attendee via the
 * SMS gateway send queue.
 *
 * The attendee's phone number is decrypted transiently under the owner's
 * session key, immediately re-encrypted under the SMS Gate E2E key, and only
 * that ciphertext is queued or transmitted — plaintext PII is never persisted.
 */

import { applyFlash } from "#routes/csrf.ts";
import { htmlResponse, redirect } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { setAttendeePhoneIndexIfEmpty } from "#shared/db/attendee-phone-index.ts";
import {
  enqueueSms,
  getSmsOutboxForAttendee,
  markSmsFailed,
  markSmsSent,
} from "#shared/db/sms-outbox.ts";
import { decryptField } from "#shared/sms/e2e.ts";
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

/** Decrypt a stored body for display, falling back to a placeholder. */
const decryptBody = async (
  bodyEnc: string,
  passphrase: string,
): Promise<string> => {
  try {
    return await decryptField(bodyEnc, passphrase);
  } catch {
    return "(unable to decrypt)";
  }
};

/** GET /admin/listing/:listingId/attendee/:attendeeId/contact */
const handleContactGet = attendeeGetRoute(async (data, session, request) => {
  const flash = applyFlash(request);
  const config = getSmsGatewayConfig();
  const rows = await getSmsOutboxForAttendee(data.attendee.id);
  const history: SmsHistoryItem[] = await Promise.all(
    rows.map(async (r) => ({
      body: config ? await decryptBody(r.body_enc, config.passphrase) : "",
      created: r.created,
      id: r.id,
      status: r.status,
    })),
  );
  return htmlResponse(
    attendeeContactPage(data, session, history, {
      configured: config !== null,
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

    // Encrypt once; the same ciphertext is both stored and transmitted.
    const payload = await buildMessagePayload(
      phone,
      message,
      config.passphrase,
    );
    const { id } = await enqueueSms({
      attendeeId,
      bodyEnc: payload.textMessage.text,
      listingId,
      phoneEnc: payload.phoneNumbers[0]!,
    });

    try {
      const { providerId } = await sendEncryptedMessage(config, payload);
      await markSmsSent(id, providerId);
      await logActivity(
        `Text message sent to attendee '${data.attendee.name}'`,
        listingId,
        attendeeId,
      );
      return redirect(backUrl, "Text message sent", true);
    } catch (e) {
      await markSmsFailed(id, String(e));
      await logActivity(
        `Text message to attendee '${data.attendee.name}' failed to send: ${String(e)}`,
        listingId,
        attendeeId,
      );
      return redirect(backUrl, "Message queued but failed to send", false);
    }
  },
);

export const attendeeContactRoutes = defineRoutes({
  "GET /admin/listing/:listingId/attendee/:attendeeId/contact":
    handleContactGet,
  "POST /admin/listing/:listingId/attendee/:attendeeId/contact":
    handleContactPost,
});
