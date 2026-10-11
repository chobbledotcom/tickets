/** The tail a booked session can still owe on a replay. A transient
 * database failure in `completePaidBooking` answers the webhook retryably
 * while the booking stays paid, so the provider redelivers. The replay
 * paths answer success for the booked session. This module re-runs the
 * missing tail first. Without it, the redelivery honours the payment and
 * loses the buyer's answers, emails, and activity lines.
 */

import { hmacHash } from "#crypto/hashing.ts";
/* jscpd:ignore-start -- imports */
import { queryBatchPrimary, resultRows } from "#db/client.ts";
import { getListingsWithCountsByIds } from "#db/listings/records.ts";
import { committedEntries } from "#routes/api/payment-processing/committed-entries.ts";
import { takeSessionAnswers } from "#routes/api/payment-processing/completion.ts";
import { saveSessionAnswers } from "#routes/api/payment-processing/create.ts";
import type { ValidatedSession } from "#routes/api/webhook-types.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { logAndNotifyRegistration } from "#shared/webhook/delivery.ts";

/* jscpd:ignore-end */

/** What the booked session's tail still owes, read off durable rows: the
 * booked lines, the committed answer save, and the committed notification.
 * The answer save is the tail's
 * first write. Only it writes `answers_at_booking`, so that record is the
 * registration-specific marker. A ticket move or an admin note can write
 * activity rows for the attendee. None of them proves the tail. The tail's
 * logActivities batch writes the attendee's first activity rows. A stored
 * registration line proves the notification phase ran. Its absence, beside
 * a committed answer save, proves the notification never did. */
const bookedTailState = async (
  attendeeId: number,
): Promise<{
  answersSaved: boolean;
  listingIds: number[];
  notified: boolean;
}> => {
  const [linesResult, answersResult, notifiedResult] = await queryBatchPrimary([
    {
      args: [attendeeId],
      sql: `SELECT listingAttendee.listing_id
                FROM listing_attendees AS listingAttendee
               WHERE listingAttendee.attendee_id = ?`,
    },
    {
      args: [attendeeId],
      sql: `SELECT 1 AS present FROM answers_at_booking
               WHERE attendee_id = ? LIMIT 1`,
    },
    {
      args: [attendeeId, attendeeId],
      sql: `SELECT 1 AS present
                FROM activity_log AS activity
               WHERE activity.attendee_id = ?
                 AND activity.listing_id IN (
                   SELECT listingAttendee.listing_id
                     FROM listing_attendees AS listingAttendee
                    WHERE listingAttendee.attendee_id = ?
                 )
               LIMIT 1`,
    },
  ]);
  return {
    answersSaved: resultRows<{ present: number }>(answersResult!).length > 0,
    listingIds: resultRows<{ listing_id: number }>(linesResult!).map(
      (row) => row.listing_id,
    ),
    notified: resultRows<{ present: number }>(notifiedResult!).length > 0,
  };
};

/** Finish a booked session's tail on a replay. The tail is done when its
 * answer save and the registration line both sit in the database. Anything
 * less resumes, whatever other activity rows the attendee holds. A line
 * whose listing is gone since the booking cannot render. Its entry drops
 * loudly. A booking with no live lines defers its notification to the
 * admin re-send. Promo-code log lines are skipped. Their amounts come from
 * a pricing that the replay must not re-run. `ticketToken` is the session's
 * stored token. It is null when the idempotency row that sealed it is gone.
 * The emails then render a check-in link no scan can open. The
 * notification defers to the admin re-send and says so loudly. A resume
 * failure throws, so the provider redelivers. */
export const resumeBookedSessionTail = async (
  sessionId: string,
  attendeeId: number,
  session: ValidatedSession["session"],
  intent: BookingIntent,
  ticketToken: string | null,
): Promise<void> => {
  const { answersSaved, listingIds, notified } =
    await bookedTailState(attendeeId);
  if (listingIds.length === 0 || (answersSaved && notified)) return;
  const listings = await getListingsWithCountsByIds(listingIds);
  const entries = await committedEntries(
    attendeeId,
    ticketToken ?? "",
    session,
    intent,
    listings
      .filter((listing) => listing !== null)
      .map((listing) => ({ listing })),
  );
  // A deleted listing leaves no entry to notify. Queueing the notification
  // for no entries sends an empty email. The staged text keeps waiting in
  // its row for a checkout that can still render it.
  if (entries.length === 0) return;
  await saveSessionAnswers(entries, intent);
  const freeTexts = await takeSessionAnswers(sessionId, intent);
  if (ticketToken === null) {
    // The hashed index, not the raw session id: for SumUp the id is the
    // checkout reference, which must not reach logs or sinks either.
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `Booked session (index ${await hmacHash(sessionId)}) owes its registration notification, but its ticket token is gone with its pruned idempotency row; the admin re-send is its recovery`,
    });
    return;
  }
  await logAndNotifyRegistration(entries, {
    freeTexts,
    siteTokenIndex: intent.siteTokenIndex,
  });
};
