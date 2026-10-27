import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  bookingEventGroup,
  mapBooking,
  mapRefund,
} from "#accounting/mappers.ts";
import { transfersByEventGroup } from "#accounting/queries.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { loadExistingLines } from "#db/attendees/atomic-update.ts";
import { withTransaction } from "#db/client.ts";
import {
  apiCreateLedgerPoster,
  postBookingLegsTx,
} from "#shared/checkout-complete.ts";
import { listPriceOrder } from "#shared/checkout-pricing.ts";
import { account } from "#shared/ledger/account.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** An attendee whose first order is posted and stamped, with the leg builder
 *  for a second order. `firstAmountPaid` shapes the first order: 0 leaves it
 *  a lone sale leg (an owed booking), anything else adds its payment leg. */
const attendeeWithPostedOrder = async (
  firstAmountPaid = 100,
): Promise<{
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
  const firstOrderLegs = await mapBooking({
    amountPaid: firstAmountPaid,
    attendeeId,
    bookingFee: 0,
    eventId: "stamp-order-one",
    lines: [{ gross: 100, listingId: listing.id }],
    modifiers: [],
    occurredAt: "2026-06-21T00:00:00.000Z",
  });
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

  test("a one-leg order still stamps the row", async () => {
    // An owed booking posts only its sale leg; the stamp must not wait for
    // a second leg to exist.
    const { attendeeId, firstOrderLegs } = await attendeeWithPostedOrder(0);

    expect(firstOrderLegs.length).toBe(1);
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

  test("apiCreateLedgerPoster posts the sale at custom prices plus payments and adjustments", async () => {
    const listing = await createTestListing({
      maxAttendees: 5,
      name: "API Poster Fair",
      unitPrice: 500,
    });
    const order = listPriceOrder([{ listing, quantity: 2, unitPrice: 400 }]);
    const made = await attendeesApi.createAttendeeAtomic(
      {
        bookings: [{ listingId: listing.id, quantity: 2 }],
        email: "api@example.com",
        name: "API Poster",
        remainingBalance: 250,
      },
      apiCreateLedgerPoster(order, {
        adjustments: [
          { amount: 100, description: "Delivery" },
          { amount: -50, description: "Loyalty" },
        ],
        payments: [600],
      }),
    );
    if (!made.success) throw new Error("booking setup failed");
    const attendeeId = made.attendees[0]!.id;

    const legs = await transfersByEventGroup(
      await bookingEventGroup(String(attendeeId)),
    );
    // Sale at the agreed 400/unit, the payment, the charge and the writeoff:
    // one event group, so a refund reverses every one of them together.
    const byKind = (kind: string) => legs.filter((leg) => leg.kind === kind);
    expect(byKind("sale")[0]!.amount).toBe(800);
    expect(byKind("sale")[0]!.destination).toEqual(
      account("revenue", listing.id),
    );
    expect(byKind("payment")[0]!.amount).toBe(600);
    expect(byKind("payment")[0]!.source).toEqual(account("external", "world"));
    expect(byKind("manual_attendee_charge")[0]!.amount).toBe(100);
    expect(byKind("manual_attendee_writeoff")[0]!.amount).toBe(50);
    expect(new Set(legs.map((leg) => leg.eventGroup)).size).toBe(1);
  });

  test("a refund of an API-created order reverses every posted leg exactly", async () => {
    const listing = await createTestListing({
      maxAttendees: 5,
      name: "API Refund Fair",
      unitPrice: 500,
    });
    const order = listPriceOrder([{ listing, quantity: 1 }]);
    const made = await attendeesApi.createAttendeeAtomic(
      {
        bookings: [{ listingId: listing.id, quantity: 1 }],
        email: "refund@example.com",
        name: "API Refund",
        remainingBalance: 550,
      },
      apiCreateLedgerPoster(order, {
        adjustments: [{ amount: 200, description: "Delivery" }],
        payments: [150],
      }),
    );
    if (!made.success) throw new Error("booking setup failed");
    const attendeeId = made.attendees[0]!.id;
    const orderLegs = await transfersByEventGroup(
      await bookingEventGroup(String(attendeeId)),
    );
    expect(orderLegs.length).toBe(3);

    const refund = await mapRefund({
      occurredAt: "2026-06-22T09:00:00.000Z",
      orderLegs,
      postedBy: "test",
    });
    expect(refund).toHaveLength(orderLegs.length);
    const sameAccountSide = (
      a: { id: string; type: string },
      b: { id: string; type: string },
    ): boolean => a.type === b.type && a.id === b.id;
    for (const leg of refund) {
      // Every reversal matches one original: same amount, endpoints swapped.
      const original = orderLegs.find(
        (candidate) =>
          candidate.amount === leg.amount &&
          sameAccountSide(candidate.source, leg.destination) &&
          sameAccountSide(candidate.destination, leg.source),
      );
      expect(original).toBeDefined();
      expect(leg.kind?.startsWith("refund_")).toBe(true);
    }
    // The cash leg comes back as refund_cash (the payment relabel), never a
    // generic refund_payment.
    const cashReturn = refund.find(
      (leg) => leg.destination.type === "external",
    );
    expect(cashReturn!.kind).toBe("refund_cash");
  });
});
