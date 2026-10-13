/**
 * The pending-notification flags on an attendee row: one flag per external
 * send a booking owes. `email_pending` is the buyer's confirmation email.
 * `webhooks_pending` is the listing's registration webhooks. The booking sets
 * its flags in the same atomic batch that creates it. Each send clears its
 * own flag only when the far side accepts the message. A failed send or a
 * crash leaves the flag up, so the admin sees the odd state.
 *
 * The stored value also says who the booking came from, which colours the
 * admin badge. A person who booked online shows red. A person an admin added
 * by hand shows orange.
 */

import { inPlaceholders, type SqlStatement } from "#db/client.ts";
import type { Attendee } from "#types";

/** The stored value of a pending-notification flag. */
export type PendingNotificationFlag = 0 | 1 | 2;

/** The flag values and what each means on the admin badge. */
export const PENDING_NOTIFICATION = {
  /** A send is owed for a person an admin added by hand (orange badge). */
  admin: 2,
  /** No send is owed. */
  none: 0,
  /** A send is owed for a person who booked online (red badge). */
  online: 1,
} as const satisfies Record<string, PendingNotificationFlag>;

/** Which flag a statement clears. */
export type PendingNotificationSide = "email" | "webhooks";

/** The flag column each side owns. */
const FLAG_COLUMN: Record<PendingNotificationSide, string> = {
  email: "email_pending",
  webhooks: "webhooks_pending",
};

/** Clear one side's flag for the given attendees. Rows whose flag is already
 * down stay untouched. A send runs this only after its far side accepted the
 * message. */
export const clearPendingFlagStatement = (
  side: PendingNotificationSide,
  attendeeIds: readonly number[],
): SqlStatement => ({
  args: [...attendeeIds],
  sql: `UPDATE attendees SET ${FLAG_COLUMN[side]} = 0
        WHERE id IN (${inPlaceholders(attendeeIds)})
          AND ${FLAG_COLUMN[side]} > 0`,
});

/** SQL for "a listing this attendee booked currently collects an email".
 * The attendee row reads and the dashboard count share it, so the badge and
 * the count cannot disagree. `attendeeRef` names the alias the attendee
 * columns read through at the call site. Writes store the contact fields as
 * the parser's own trimmed tokens (`storedListingFields`). The read strips
 * spaces and non-breaking spaces before the match. A padded value an older
 * version wrote then reads exactly the tokens the parser reads.
 * Ghost lines (quantity 0) are not bookings. */
export const emailOwedSql = (attendeeRef: string): string => `EXISTS (
  SELECT 1 FROM listing_attendees AS owed_line
  JOIN listings AS owed_listing ON owed_listing.id = owed_line.listing_id
  WHERE owed_line.attendee_id = ${attendeeRef}.id
    AND owed_line.quantity > 0
    AND instr(',' || REPLACE(REPLACE(owed_listing.fields, ' ', ''), CHAR(160), '') || ',', ',email,') > 0
)`;

/** Whether the email badge shows for one attendee row: the stored flag is up
 * and a booked listing still collects an email. The read that produced the
 * row resolved that rule into `email_owed`. */
export const emailBadgeOwed = (
  attendee: Pick<Attendee, "email_owed" | "email_pending">,
): boolean => attendee.email_pending > 0 && attendee.email_owed === 1;
