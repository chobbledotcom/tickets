/** Shared seeding and reversal helpers for the refunded-projection tests. */

import { attendeeAccount } from "#accounting/accounts.ts";
import {
  bookingEventGroup,
  mapBooking,
  mapRefund,
} from "#accounting/mappers.ts";
import { transfersByAccount } from "#accounting/queries.ts";
import { postTransferGroups } from "#accounting/store.ts";
import type { CreateAttendeeResult } from "#db/attendee-types.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { getDb, withTransaction } from "#db/client.ts";
import { postBookingLegsTx } from "#shared/checkout-complete.ts";
import type { Transfer, TransferInput } from "#shared/ledger/types.ts";
import { createPaidListing } from "#test/features/admin/refunds-helpers.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import type { Attendee } from "#types";

export const PRICE = 500;
export const REVERSED_AT = "2026-08-11T00:00:00.000Z";

/** BalanceOf ignores ids; placeholder fields keep freshly built inputs usable
 *  wherever a reversal's stored legs are expected. */
export const asTransfer = (input: TransferInput): Transfer => ({
  ...input,
  id: 0,
  recordedAt: REVERSED_AT,
});

/** Every booking order this person holds, as the leg group of each order. */
const ordersHeldBy = async (attendeeId: number): Promise<Transfer[][]> => [
  ...Map.groupBy(
    (await transfersByAccount(attendeeAccount(attendeeId))).filter(
      (leg) => !leg.kind?.startsWith("refund_"),
    ),
    (leg) => leg.eventGroup,
  ).values(),
];

/** Reverse one order, as a provider refund of that order's charge does. */
const reverseOrder = async (order: Transfer[]): Promise<void> => {
  await postTransferGroups([
    await mapRefund({ occurredAt: REVERSED_AT, orderLegs: order }),
  ]);
};

/** Reverse the one order holding a leg for `listingId`. */
export const reverseOrderFor = async (
  attendeeId: number,
  listingId: number,
): Promise<void> => {
  const target = (await ordersHeldBy(attendeeId)).find((order) =>
    order.some((leg) => leg.destination.id === String(listingId)),
  );
  if (target === undefined) {
    throw new Error(`No order found for listing ${listingId}`);
  }
  await reverseOrder(target);
};

/** Reverse the order identified by its derived event group. */
export const reverseOrderGroup = async (
  attendeeId: number,
  group: string,
): Promise<void> => {
  const target = (await ordersHeldBy(attendeeId)).find(
    (order) => order[0]!.eventGroup === group,
  );
  if (target === undefined) {
    throw new Error(`No order found for group ${group}`);
  }
  await reverseOrder(target);
};

/** Reverse ONLY some sales of an order — the legs a partial provider refund
 *  would give back when the rest of the order stays with the provider. */
export const reverseSales = async (
  sales: readonly Transfer[],
): Promise<void> => {
  await postTransferGroups([
    await mapRefund({ occurredAt: REVERSED_AT, orderLegs: [...sales] }),
  ]);
};

/** The row's own flag, in the shape the row type declares. The SQL emits 0/1,
 *  so the assertions below compare against those — the truth the callers read
 *  through `!a.refunded` and `if (entry.attendee.refunded)`. */
export const refundedOn = async (
  listingId: number,
  attendeeId: number,
  date?: string,
): Promise<Attendee["refunded"]> => {
  const row = (await getAttendeesRaw(listingId)).find(
    (entry) =>
      entry.id === attendeeId && (date === undefined || entry.date === date),
  );
  if (row === undefined) {
    throw new Error(
      `Attendee ${attendeeId} has no row on listing ${listingId}` +
        (date === undefined ? "" : ` on ${date}`),
    );
  }
  return row.refunded;
};

/** The name-and-email half every seeder here needs before it can read rows
 *  back, with the guard kept once: a refused booking is a broken setup, and
 *  the refusal must say so instead of seeding on. */
const bookAtomically = async (
  input: Parameters<typeof attendeesApi.createAttendeeAtomic>[0],
): Promise<Extract<CreateAttendeeResult, { success: true }>> => {
  const made = await attendeesApi.createAttendeeAtomic(input);
  if (!made.success) throw new Error("booking setup failed");
  return made;
};

/** One person holding two orders, one per listing — the shape a merge leaves
 *  behind, and the only shape a partial reversal can arise in. */
export const bookTwoListings = async (): Promise<{
  attendeeId: number;
  cameBack: number;
  stillPaid: number;
}> => {
  const cameBack = await createPaidListing({ name: "Came back" });
  const stillPaid = await createPaidListing({ name: "Still paid" });
  const made = await bookAtomically({
    bookings: [
      { listingId: cameBack.id, pricePaid: PRICE },
      { listingId: stillPaid.id, pricePaid: PRICE },
    ],
    email: "two@example.com",
    name: "Two Orders",
  });
  const attendeeId = made.attendees[0]!.id;
  for (const listingId of [cameBack.id, stillPaid.id]) {
    await postListingSale({ attendeeId, gross: PRICE, listingId });
  }
  return { attendeeId, cameBack: cameBack.id, stillPaid: stillPaid.id };
};

/** Two days one listing is booked for, each as its own order. */
export const DAYS = ["2026-09-20", "2026-09-21"] as const;

/** One person holding TWO orders for the SAME listing on two days — the shape
 *  a merge of two people (or two separate daily bookings) leaves behind. Each
 *  order's legs are posted and stamped onto exactly its own row. */
export const bookTwoOrdersOnOneListing = async (): Promise<{
  attendeeId: number;
  listingId: number;
  secondGroup: string;
}> => {
  const listing = await createDailyTestListing({ unitPrice: PRICE });
  const made = await bookAtomically({
    bookings: [{ date: DAYS[0], listingId: listing.id, pricePaid: PRICE }],
    email: "same-listing@example.com",
    name: "Two Days",
  });
  const attendeeId = made.attendees[0]!.id;
  // The second order's row, as a merge moves it in: the same listing on
  // another day, so the booking-slot identity stays distinct.
  await getDb().execute({
    args: [attendeeId, listing.id, `${DAYS[1]}T00:00:00Z`],
    sql:
      "INSERT INTO listing_attendees (attendee_id, listing_id, start_at)" +
      " VALUES (?, ?, ?)",
  });
  await postListingSale({
    attendeeId,
    eventId: "order-one",
    gross: PRICE,
    listingId: listing.id,
    stampStartAt: `${DAYS[0]}T00:00:00Z`,
  });
  await postListingSale({
    attendeeId,
    eventId: "order-two",
    gross: PRICE,
    listingId: listing.id,
    stampStartAt: `${DAYS[1]}T00:00:00Z`,
  });
  return {
    attendeeId,
    listingId: listing.id,
    secondGroup: await bookingEventGroup("order-two"),
  };
};

/** One order of paid listings plus one free line (a package's free member)
 *  through the production stamp, with its sale legs named. */
export const orderWithPaidLinesAndAFreeMember = async (
  paidIds: number[],
  email: string,
): Promise<{
  attendeeId: number;
  freeId: number;
  sales: Transfer[];
}> => {
  const free = await createTestListing({ maxAttendees: 10, unitPrice: 0 });
  const made = await bookAtomically({
    bookings: [
      ...paidIds.map((listingId) => ({ listingId, pricePaid: PRICE })),
      { listingId: free.id, pricePaid: 0 },
    ],
    email,
    name: "Paid And Free",
  });
  const attendeeId = made.attendees[0]!.id;
  const legs = await mapBooking({
    amountPaid: PRICE * paidIds.length,
    attendeeId,
    bookingFee: 0,
    eventId: `mixed-order-${email}`,
    lines: [
      ...paidIds.map((listingId) => ({ gross: PRICE, listingId })),
      { gross: 0, listingId: free.id },
    ],
    modifiers: [],
    occurredAt: REVERSED_AT,
  });
  await withTransaction((tx) => postBookingLegsTx(tx, attendeeId, legs));
  return {
    attendeeId,
    freeId: free.id,
    sales: legs.filter((leg) => leg.kind === "sale").map(asTransfer),
  };
};

/** One paid line plus one free line in one order, naming the paid listing. */
export const bookPaidAndFreeOrder = async (): Promise<{
  attendeeId: number;
  freeId: number;
  paidId: number;
}> => {
  const paid = await createPaidListing({ name: "Paid" });
  const { attendeeId, freeId } = await orderWithPaidLinesAndAFreeMember(
    [paid.id],
    "mixed-order@example.com",
  );
  return { attendeeId, freeId, paidId: paid.id };
};

/** One order of a FREE listing plus a booking fee: stamped and posted through
 *  the production path, but NO sale leg exists anywhere in the order — the
 *  money the attendee paid is the fee alone. */
export const orderWithAFeeAndAFreeLine = async (): Promise<{
  attendeeId: number;
  legs: Transfer[];
  freeId: number;
}> => {
  const free = await createTestListing({ maxAttendees: 10, unitPrice: 0 });
  const made = await bookAtomically({
    bookings: [{ listingId: free.id, pricePaid: 0 }],
    email: "fee-and-free@example.com",
    name: "Fee And Free",
  });
  const attendeeId = made.attendees[0]!.id;
  const legs = (
    await mapBooking({
      amountPaid: 150,
      attendeeId,
      bookingFee: 150,
      eventId: `fee-order-${attendeeId}`,
      lines: [{ gross: 0, listingId: free.id }],
      modifiers: [],
      occurredAt: REVERSED_AT,
    })
  ).map(asTransfer);
  await withTransaction((tx) => postBookingLegsTx(tx, attendeeId, legs));
  return { attendeeId, freeId: free.id, legs };
};
