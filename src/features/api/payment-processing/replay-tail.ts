/** The tail a booked session can still owe on a replay. A transient database
 * failure in `completePaidBooking` answers the webhook retryably while the
 * booking stays paid. The provider redelivers, and this module finishes the
 * missing tail first.
 *
 * Ownership comes from the work row the booking was born with. Its lease is
 * claimed atomically, its `delivered_at` is the registration completion
 * marker, and its sealed payload holds the ticket token and free texts. A
 * replay whose processed_payments row was pruned sends a confirmation with
 * a working check-in link.
 */

import { hmacHash } from "#crypto/hashing.ts";
import { queryAllPrimary } from "#db/client.ts";
import {
  claimOrInsertRegistrationWork,
  claimRegistrationWorkOrNull,
  deliverRegistrationWork,
  markRegistrationWorkDelivered,
  payloadFreeTexts,
  releaseRegistrationWork,
} from "#db/registration-notification-work.ts";
import { committedLiveEntries } from "#routes/api/payment-processing/committed-entries.ts";
import { saveSessionAnswers } from "#routes/api/payment-processing/create.ts";
import type {
  PaymentFailureResult,
  PaymentResult,
  ValidatedSession,
} from "#routes/api/webhook-types.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { logAndNotifyRegistration } from "#shared/webhook/delivery.ts";

/** The attendee's booked listings, the lines the entries are built from. */
const bookedListingIds = async (attendeeId: number): Promise<number[]> => {
  const lines = await queryAllPrimary<{ listing_id: number }>({
    args: [attendeeId],
    sql: `SELECT listingAttendee.listing_id
            FROM listing_attendees AS listingAttendee
           WHERE listingAttendee.attendee_id = ?`,
  });
  return lines.map((row) => row.listing_id);
};

/** Say loudly why this delivery deferred the notification instead of
 * running it. */
const logNotificationDeferred = async (
  sessionId: string,
  reason: string,
): Promise<void> => {
  logError({
    code: ErrorCode.PAYMENT_SESSION,
    detail: `Booked session (index ${await hmacHash(sessionId)}) owes its registration notification. ${reason} The admin re-send is its recovery`,
  });
};

/** The answer a delivery gives while another delivery holds an undelivered
 * lease. Retryable, so the provider comes back after the holder finishes or
 * the lease goes stale. */
export const heldTailAnswer = (): PaymentFailureResult => ({
  error: "Payment is being processed. Please wait a moment and refresh.",
  status: 409,
  success: false,
});

/** Finish a booked session's tail on a replay. Claim the notification,
 * save the answers, and run the notification once. The answers save is a
 * whole replace, so a re-run lands the same rows. The work row's payload
 * carries the ticket token and free texts, so the notification matches the
 * first delivery's even when the stored tokens are gone.
 *
 * `fallbackToken` is the session's stored token, for a booking that
 * predates the work table. The conflict surface holds one. The ledger
 * surface holds none, so its emails defer to the admin re-send.
 *
 * Returns the answer to give instead of success: a held lease answers
 * retryably, because its owner can die before finishing. */
export const resumeBookedSessionTail = async (
  sessionId: string,
  attendeeId: number,
  session: ValidatedSession["session"],
  intent: BookingIntent,
  fallbackToken: string | null,
): Promise<PaymentResult | null> => {
  const listingIds = await bookedListingIds(attendeeId);
  if (listingIds.length === 0) return null;
  let work = await claimRegistrationWorkOrNull(sessionId);
  if (work === null) {
    // A missing row is owed work. Bookings completed before this table were
    // copied in stamped delivered by its migration. A delivered row lives
    // with its booking, so no completed booking loses its row.
    if (fallbackToken === null) {
      // No work row and no stored token: the booking predates the work
      // table, and no plaintext token was ever sealed for it. The durable
      // half of the tail still lands. The notification defers.
      await saveSessionAnswers(
        await committedLiveEntries(listingIds, {
          attendeeId,
          intent,
          session,
          ticketToken: "",
        }),
        intent,
      );
      await logNotificationDeferred(
        sessionId,
        "No notification payload was ever sealed for this booking.",
      );
      return null;
    }
    // One atomic sequence decides ownership. The insert wins a missing row,
    // a claimable row leases, and a held or delivered row answers from its
    // actual state. An invented claim notifies twice.
    work = await claimOrInsertRegistrationWork(sessionId, {
      ticketToken: fallbackToken,
    });
  }
  if (work.kind === "delivered") return null;
  if (work.kind === "owned") {
    // A held lease is not a finished tail: its holder can die after
    // claiming. Answer retryably so the provider comes back.
    return heldTailAnswer();
  }
  const payload = work.payload;
  try {
    // A line whose listing is gone since the booking drops loudly: no
    // notification can name a deleted listing. A booking with no live lines
    // marks the work delivered, because the notification is genuinely
    // impossible and the admin re-send is its only path.
    const entries = await committedLiveEntries(listingIds, {
      attendeeId,
      intent,
      session,
      ticketToken: payload.ticketToken,
    });
    if (entries.length === 0) {
      await logNotificationDeferred(
        sessionId,
        "Every one of its lines lost its listing.",
      );
      await markRegistrationWorkDelivered(sessionId);
      return null;
    }
    await saveSessionAnswers(entries, intent);
    await deliverRegistrationWork(sessionId, () =>
      logAndNotifyRegistration(entries, {
        awaitNotifications: true,
        freeTexts: payloadFreeTexts(payload),
        siteTokenIndex: intent.siteTokenIndex,
      }),
    );
  } catch (error) {
    // The failure happened after claiming, before the notification's own
    // release boundary. Free the lease, so the redelivery this throw causes
    // claims fresh instead of finding a held lease.
    await releaseRegistrationWork(sessionId);
    throw error;
  }
  return null;
};
