/**
 * The refunded projection against a real ledger.
 *
 * `select.test.ts` pins the SQL this builder emits; these pin what that SQL
 * ANSWERS once a partial reversal exists, which is the case a string test
 * cannot see. A booking whose own money is still with the provider must not
 * read as refunded because a DIFFERENT booking of the same person came back —
 * the scanner and check-in both turn people away on this flag — and a line
 * whose whole ORDER came back must read refunded even when the line itself
 * was free (a package's free member).
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeeAccount } from "#accounting/accounts.ts";
import {
  bookingEventGroup,
  mapBooking,
  mapRefund,
} from "#accounting/mappers.ts";
import { transfersByAccount } from "#accounting/queries.ts";
import { postTransferGroups } from "#accounting/store.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { getDb, withTransaction } from "#db/client.ts";
import { postBookingLegsTx } from "#shared/checkout-complete.ts";
import type { Transfer, TransferInput } from "#shared/ledger/types.ts";
import { createPaidListing } from "#test/features/admin/refunds-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import type { Attendee } from "#types";

const PRICE = 500;
const REVERSED_AT = "2026-08-11T00:00:00.000Z";

/** BalanceOf ignores ids; placeholder fields keep freshly built inputs usable
 *  wherever a reversal's stored legs are expected. */
const asTransfer = (input: TransferInput): Transfer => ({
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
const reverseOrderFor = async (
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
const reverseOrderGroup = async (
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

/** One person's booking row on a listing — optionally pinned to a date, for
 *  one listing booked on two days. */
const bookingRow = async (
  listingId: number,
  attendeeId: number,
  date?: string,
): Promise<Attendee> => {
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
  return row;
};

/** The row's own flag, in the shape the row type declares. The SQL emits 0/1,
 *  so the assertions below compare against those — the truth the callers read
 *  through `!a.refunded` and `if (entry.attendee.refunded)`. */
const refundedOn = async (
  listingId: number,
  attendeeId: number,
  date?: string,
): Promise<Attendee["refunded"]> =>
  (await bookingRow(listingId, attendeeId, date)).refunded;

/** One person holding two orders, one per listing — the shape a merge leaves
 *  behind, and the only shape a partial reversal can arise in. */
const bookTwoListings = async (): Promise<{
  attendeeId: number;
  cameBack: number;
  stillPaid: number;
}> => {
  const cameBack = await createPaidListing({ name: "Came back" });
  const stillPaid = await createPaidListing({ name: "Still paid" });
  const made = await attendeesApi.createAttendeeAtomic({
    bookings: [
      { listingId: cameBack.id, pricePaid: PRICE },
      { listingId: stillPaid.id, pricePaid: PRICE },
    ],
    email: "two@example.com",
    name: "Two Orders",
  });
  if (!made.success) throw new Error("booking setup failed");
  const attendeeId = made.attendees[0]!.id;
  for (const listingId of [cameBack.id, stillPaid.id]) {
    await postListingSale({ attendeeId, gross: PRICE, listingId });
  }
  return { attendeeId, cameBack: cameBack.id, stillPaid: stillPaid.id };
};

/** Two days one listing is booked for, each as its own order. */
const DAYS = ["2026-09-20", "2026-09-21"] as const;

/** One person holding TWO orders for the SAME listing on two days — the shape
 *  a merge of two people (or two separate daily bookings) leaves behind. Each
 *  order's legs are posted and stamped onto exactly its own row. */
const bookTwoOrdersOnOneListing = async (): Promise<{
  attendeeId: number;
  listingId: number;
  secondGroup: string;
}> => {
  const listing = await createDailyTestListing({ unitPrice: PRICE });
  const made = await attendeesApi.createAttendeeAtomic({
    bookings: [{ date: DAYS[0], listingId: listing.id, pricePaid: PRICE }],
    email: "same-listing@example.com",
    name: "Two Days",
  });
  if (!made.success) throw new Error("booking setup failed");
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

/** One order of the given paid listings plus one free line (a package's free
 *  member). The legs are posted through the production booking stamp, so every
 *  row — the free line included — carries the order's event group the way
 *  checkout leaves it, and the free line has no sale leg of its own. */
const orderWithPaidLinesAndAFreeMember = async (
  paidIds: number[],
  email: string,
): Promise<{
  attendeeId: number;
  freeId: number;
  sales: Transfer[];
}> => {
  const free = await createTestListing({ maxAttendees: 10, unitPrice: 0 });
  const made = await attendeesApi.createAttendeeAtomic({
    bookings: [
      ...paidIds.map((listingId) => ({ listingId, pricePaid: PRICE })),
      { listingId: free.id, pricePaid: 0 },
    ],
    email,
    name: "Paid And Free",
  });
  if (!made.success) throw new Error("booking setup failed");
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
const bookPaidAndFreeOrder = async (): Promise<{
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
const orderWithAFeeAndAFreeLine = async (): Promise<{
  attendeeId: number;
  legs: Transfer[];
  freeId: number;
}> => {
  const free = await createTestListing({ maxAttendees: 10, unitPrice: 0 });
  const made = await attendeesApi.createAttendeeAtomic({
    bookings: [{ listingId: free.id, pricePaid: 0 }],
    email: "fee-and-free@example.com",
    name: "Fee And Free",
  });
  if (!made.success) throw new Error("booking setup failed");
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

/** Reverse ONLY some sales of an order — the legs a partial provider refund
 *  would give back when the rest of the order stays with the provider. */
const reverseSales = async (sales: readonly Transfer[]): Promise<void> => {
  await postTransferGroups([
    await mapRefund({ occurredAt: REVERSED_AT, orderLegs: [...sales] }),
  ]);
};

describeWithEnv(
  "db > attendees > refunded after a partial refund",
  { db: true },
  () => {
    describe("one order reversed, another still paid", () => {
      test("the reversed booking reads refunded", async () => {
        const { attendeeId, cameBack } = await bookTwoListings();
        await reverseOrderFor(attendeeId, cameBack);

        expect(await refundedOn(cameBack, attendeeId)).toBe(1);
      });

      // A reversal leg only names the order it undid, so an order whose
      // provider charge was never returned keeps reading paid.
      test("the booking still with the provider does not", async () => {
        const { attendeeId, cameBack, stillPaid } = await bookTwoListings();
        await reverseOrderFor(attendeeId, cameBack);

        expect(await refundedOn(stillPaid, attendeeId)).toBe(0);
      });

      // A free booking has no sale leg, like a placeholder — but no money
      // either, so it must never read another listing's returned cash.
      test("a free booking beside a refunded one is not refunded", async () => {
        const free = await createTestListing({
          maxAttendees: 10,
          unitPrice: 0,
        });
        const paid = await createPaidListing({ name: "Paid" });
        const made = await attendeesApi.createAttendeeAtomic({
          bookings: [
            { listingId: free.id, pricePaid: 0 },
            { listingId: paid.id, pricePaid: PRICE },
          ],
          email: "mixed@example.com",
          name: "Free And Paid",
        });
        if (!made.success) throw new Error("booking setup failed");
        const attendeeId = made.attendees[0]!.id;
        await postListingSale({ attendeeId, gross: PRICE, listingId: paid.id });

        await reverseOrderFor(attendeeId, paid.id);

        expect(await refundedOn(paid.id, attendeeId)).toBe(1);
        expect(await refundedOn(free.id, attendeeId)).toBe(0);
      });

      test("reversing both leaves neither booking paid", async () => {
        const { attendeeId, cameBack, stillPaid } = await bookTwoListings();
        await reverseOrderFor(attendeeId, cameBack);
        await reverseOrderFor(attendeeId, stillPaid);

        expect(await refundedOn(cameBack, attendeeId)).toBe(1);
        expect(await refundedOn(stillPaid, attendeeId)).toBe(1);
      });
    });

    describe("two orders for the SAME listing", () => {
      // Each order's reversal belongs to that order alone: one person's
      // still-paid order must keep its ticket live at the door.
      test("reversing one order's charge does not refund the other", async () => {
        const { attendeeId, listingId, secondGroup } =
          await bookTwoOrdersOnOneListing();
        await reverseOrderGroup(attendeeId, secondGroup);

        expect(await refundedOn(listingId, attendeeId, DAYS[1])).toBe(1);
        expect(await refundedOn(listingId, attendeeId, DAYS[0])).toBe(0);
      });

      test("before any reversal, neither order reads refunded", async () => {
        const { attendeeId, listingId } = await bookTwoOrdersOnOneListing();

        expect(await refundedOn(listingId, attendeeId, DAYS[0])).toBe(0);
        expect(await refundedOn(listingId, attendeeId, DAYS[1])).toBe(0);
      });
    });

    describe("a free line of a wholly-reversed order", () => {
      // A free line reads the order as a whole: it has no sale leg of its
      // own, so only the order's complete return un-books its ticket.
      test("reads refunded when the order's sale came back", async () => {
        const { attendeeId, freeId, paidId } = await bookPaidAndFreeOrder();
        await reverseOrderFor(attendeeId, paidId);

        expect(await refundedOn(paidId, attendeeId)).toBe(1);
        expect(await refundedOn(freeId, attendeeId)).toBe(1);
      });

      test("stays live while the order's sale is still with the provider", async () => {
        const { attendeeId, freeId, paidId } = await bookPaidAndFreeOrder();

        expect(await refundedOn(paidId, attendeeId)).toBe(0);
        expect(await refundedOn(freeId, attendeeId)).toBe(0);
      });

      test("stays live while only SOME of the order's sales came back", async () => {
        // Two paid lines and one free line in one order: returning one paid
        // line's money leaves the other paid line live, so the free member's
        // ticket stays live too.
        const first = await createPaidListing({ name: "Part one" });
        const second = await createPaidListing({ name: "Part two" });
        const { attendeeId, freeId, sales } =
          await orderWithPaidLinesAndAFreeMember(
            [first.id, second.id],
            "partially-reversed@example.com",
          );
        await reverseSales([sales[0]!]);

        expect(await refundedOn(first.id, attendeeId)).toBe(1);
        expect(await refundedOn(second.id, attendeeId)).toBe(0);
        expect(await refundedOn(freeId, attendeeId)).toBe(0);
      });

      test("reads refunded once every sale of the order came back", async () => {
        const first = await createPaidListing({ name: "Whole one" });
        const second = await createPaidListing({ name: "Whole two" });
        const { attendeeId, freeId, sales } =
          await orderWithPaidLinesAndAFreeMember(
            [first.id, second.id],
            "wholly-reversed@example.com",
          );
        await reverseSales(sales);

        expect(await refundedOn(first.id, attendeeId)).toBe(1);
        expect(await refundedOn(second.id, attendeeId)).toBe(1);
        expect(await refundedOn(freeId, attendeeId)).toBe(1);
      });
    });

    describe("a free line of an order with no sale legs", () => {
      // A stamped order whose only money is a booking fee has no sale leg at
      // all, so "every sale came back" is vacuously true. The order's own
      // reversal is the positive evidence: the ticket stays live until one
      // exists.
      test("stays live while nothing was reversed", async () => {
        const { attendeeId, freeId, legs } = await orderWithAFeeAndAFreeLine();
        expect(legs.filter((leg) => leg.kind === "sale")).toEqual([]);

        expect(await refundedOn(freeId, attendeeId)).toBe(0);
      });

      test("reads refunded once the fee order itself was reversed", async () => {
        const { attendeeId, freeId, legs } = await orderWithAFeeAndAFreeLine();
        await postTransferGroups([
          await mapRefund({ occurredAt: REVERSED_AT, orderLegs: legs }),
        ]);

        expect(await refundedOn(freeId, attendeeId)).toBe(1);
      });
    });
  },
);
