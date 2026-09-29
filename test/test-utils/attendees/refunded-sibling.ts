import { getDb } from "#db/client.ts";
import { reverseOrderFor } from "#test/shared/db/attendees/select-refunded/support.ts";
import { createDualPackageAttendee } from "#test-utils/attendees/helpers.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import type { Attendee } from "#types";

/** A person who holds a refunded package line (quantity 2) beside a live
 * standalone line (quantity 1) on one listing. Each line rides its own paid
 * order, and the package line's order is reversed. */
export const bookRefundedSibling = async (
  listingId: number,
  groupId: number,
  name: string,
  email: string,
): Promise<Attendee> => {
  const attendee = await createDualPackageAttendee(
    listingId,
    groupId,
    name,
    email,
  );
  // postListingSale stamps every un-stamped row onto the first order, so
  // point the standalone row at its own order before the reversal.
  await postListingSale({
    attendeeId: attendee.id,
    eventId: "order-a",
    gross: 100,
    listingId,
  });
  const secondOrder = await postListingSale({
    attendeeId: attendee.id,
    eventId: "order-b",
    gross: 100,
    listingId,
  });
  await getDb().execute({
    args: [secondOrder, attendee.id, listingId],
    sql:
      "UPDATE listing_attendees SET ledger_event_group = ?" +
      " WHERE attendee_id = ? AND listing_id = ? AND package_group_id = 0",
  });
  await reverseOrderFor(attendee.id, listingId);
  return attendee;
};
