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

import {
  executeBatch,
  inPlaceholders,
  resultRows,
  type SqlStatement,
  withTransaction,
} from "#db/client.ts";

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

/** Zero one side's flag for the given attendees. Touches rows whose flag is
 * up, and is what a send runs after its far side accepted. */
export const clearPendingFlagStatement = (
  side: PendingNotificationSide,
  attendeeIds: readonly number[],
): SqlStatement => ({
  args: [...attendeeIds],
  sql: `UPDATE attendees SET ${FLAG_COLUMN[side]} = 0
        WHERE id IN (${inPlaceholders(attendeeIds)})
          AND ${FLAG_COLUMN[side]} > 0`,
});

/** Write one side's flag back to the value the claim found. Touches rows
 * whose flag is down, and is what releases a recovery's claim. The captured
 * value keeps an admin-added line's orange badge from turning red. */
export const restorePendingFlagStatement = (
  side: PendingNotificationSide,
  attendeeIds: readonly number[],
  value: PendingNotificationFlag,
): SqlStatement => ({
  args: [value, ...attendeeIds],
  sql: `UPDATE attendees SET ${FLAG_COLUMN[side]} = ?
        WHERE id IN (${inPlaceholders(attendeeIds)})
          AND ${FLAG_COLUMN[side]} = 0`,
});

/** One side a recovery claimed, with the flag value the claim found. The
 * restore writes this value back, so a refused or failed send keeps the
 * badge's who-owes-this colour. */
export type ClaimedNotificationSide = {
  side: PendingNotificationSide;
  previous: PendingNotificationFlag;
};

/** Claim an attendee's outstanding pending-notification flags for one
 * recovery. The read and the write share one transaction, so the captured
 * values are the values the claim zeroed. A recovery that races another
 * finds nothing outstanding and claims nothing, so only one of the two
 * queues external sends. */
export const claimOutstandingNotificationFlags = async (
  attendeeId: number,
): Promise<ClaimedNotificationSide[]> =>
  withTransaction(async (tx) => {
    const read = await tx.execute({
      args: [attendeeId],
      sql: "SELECT email_pending AS email, webhooks_pending AS webhooks FROM attendees WHERE id = ?",
    });
    const row = resultRows<{
      email: PendingNotificationFlag;
      webhooks: PendingNotificationFlag;
    }>(read)[0];
    if (row === undefined) return [];
    const sides: readonly [PendingNotificationSide, PendingNotificationFlag][] =
      [
        ["email", row.email],
        ["webhooks", row.webhooks],
      ];
    const claimed = sides
      .filter(([, value]) => value > 0)
      .map(([side, previous]) => ({ previous, side }));
    if (claimed.length > 0) {
      await tx.execute({
        args: [attendeeId],
        sql: "UPDATE attendees SET email_pending = 0, webhooks_pending = 0 WHERE id = ?",
      });
    }
    return claimed;
  });

/** Put one recovery's claimed sides back to the values the claim found. The
 * claim flipped them down as a lease for sends that never ran, so the flags
 * must keep saying a send is owed. Unclaimed sides stay untouched. */
export const restoreClaimedNotificationFlags = (
  attendeeId: number,
  claimed: readonly ClaimedNotificationSide[],
): Promise<unknown> =>
  executeBatch(
    claimed.map(({ previous, side }) =>
      restorePendingFlagStatement(side, [attendeeId], previous),
    ),
  );
