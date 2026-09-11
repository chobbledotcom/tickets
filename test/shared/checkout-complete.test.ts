import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { mapBooking } from "#accounting/mappers.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { loadExistingLines } from "#db/attendees/atomic-update.ts";
import { withTransaction } from "#db/client.ts";
import { postBookingLegsTx } from "#shared/checkout-complete.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** An attendee whose first order is posted and stamped, with the leg builder
 *  for a second order. */
const attendeeWithPostedOrder = async (): Promise<{
  attendeeId: number;
  firstOrderLegs: Awaited<ReturnType<typeof mapBooking>>;
  nextOrderLegs: (
    gross: number,
    eventId: string,
  ) => ReturnType<typeof mapBooking>;
}> => {
  const listing = await createTestListing({ maxAttendees: 5 });
  const made = await attendeesApi.createAttendeeAtomic({
    bookings: [{ listingId: listing.id, quantity: 1 }],
    email: "stamps@example.com",
    name: "Stamps",
  });
  if (!made.success) throw new Error("booking setup failed");
  const attendeeId = made.attendees[0]!.id;
  const orderLegs = (gross: number, eventId: string) =>
    mapBooking({
      amountPaid: gross,
      attendeeId,
      bookingFee: 0,
      eventId,
      lines: [{ gross, listingId: listing.id }],
      modifiers: [],
      occurredAt: "2026-06-21T00:00:00.000Z",
    });
  const firstOrderLegs = await orderLegs(100, "stamp-order-one");
  await withTransaction((tx) =>
    postBookingLegsTx(tx, attendeeId, firstOrderLegs),
  );
  return { attendeeId, firstOrderLegs, nextOrderLegs: orderLegs };
};

const stampOfFirstLine = async (attendeeId: number): Promise<string> => {
  const lines = await loadExistingLines(attendeeId);
  if (lines.length === 0) throw new Error("no booking line to read");
  return lines[0]!.booking.ledger_event_group;
};

describeWithEnv("checkout-complete > postBookingLegsTx", { db: true }, () => {
  test("posts the legs and stamps every row of the order", async () => {
    const { attendeeId, firstOrderLegs } = await attendeeWithPostedOrder();

    expect(await stampOfFirstLine(attendeeId)).toBe(
      firstOrderLegs[0]!.eventGroup,
    );
  });

  // A booking row's `ledger_event_group` must name ITS order. An attendee
  // who already holds an order (the state a merge leaves) must keep that
  // order's rows pointing at its legs when a later order posts: the stamp
  // fills only rows still carrying no order, never overwrites one.
  test("stamps only rows the order created, never an earlier order's rows", async () => {
    const { attendeeId, firstOrderLegs, nextOrderLegs } =
      await attendeeWithPostedOrder();

    const second = await nextOrderLegs(200, "stamp-order-two");
    await withTransaction((tx) => postBookingLegsTx(tx, attendeeId, second));

    expect(await stampOfFirstLine(attendeeId)).toBe(
      firstOrderLegs[0]!.eventGroup,
    );
  });
});
