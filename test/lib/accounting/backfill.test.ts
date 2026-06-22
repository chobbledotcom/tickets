import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  revenueAccount,
  WORLD,
} from "#shared/accounting/accounts.ts";
import { backfillTransfers } from "#shared/accounting/backfill.ts";
import {
  accountBalance,
  allTransfers,
  transfersByAccount,
} from "#shared/accounting/queries.ts";
import type { ListingBooking } from "#shared/db/attendee-types.ts";
import { createAttendeeAtomic, markRefunded } from "#shared/db/attendees.ts";
import { getDb } from "#shared/db/client.ts";
import type { Transfer } from "#shared/ledger/types.ts";
import { createTestListing, describeWithEnv } from "#test-utils";

/** Create a historical paid booking with NO ledger legs (pre-dual-write). */
const historicalBooking = async (bookings: ListingBooking[]) => {
  const result = await createAttendeeAtomic({
    bookings,
    email: "a@b.c",
    name: "Historical",
  });
  if (!result.success) throw new Error(`setup failed: ${result.reason}`);
  return result.attendees[0]!;
};

const refundCashOf = (legs: Transfer[]): Transfer[] =>
  legs.filter((leg) => leg.kind === "refund_cash");

describeWithEnv("accounting > backfill", { db: true }, () => {
  test("reconstructs sale + payment for a paid booking", async () => {
    const listing = await createTestListing({ maxAttendees: 5 });
    const attendee = await historicalBooking([
      { listingId: listing.id, pricePaid: 5000 },
    ]);
    expect((await allTransfers()).length).toBe(0); // no legs yet

    await backfillTransfers("GBP");

    expect(await accountBalance(revenueAccount(listing.id))).toBe(5000);
    expect(await accountBalance(attendeeAccount(attendee.id))).toBe(0); // paid full
    expect(await accountBalance(WORLD)).toBe(-5000); // cash in
  });

  test("groups a multi-listing booking into one order (sales + one payment)", async () => {
    const first = await createTestListing({ maxAttendees: 5 });
    const second = await createTestListing({ maxAttendees: 5 });
    const attendee = await historicalBooking([
      { listingId: first.id, pricePaid: 3000 },
      { listingId: second.id, pricePaid: 2000 },
    ]);

    await backfillTransfers("GBP");

    expect(await accountBalance(revenueAccount(first.id))).toBe(3000);
    expect(await accountBalance(revenueAccount(second.id))).toBe(2000);
    expect(await accountBalance(attendeeAccount(attendee.id))).toBe(0);
    const legs = await transfersByAccount(attendeeAccount(attendee.id));
    // Two sales + one payment, all under one event group.
    expect(legs.length).toBe(3);
    expect(new Set(legs.map((leg) => leg.eventGroup)).size).toBe(1);
    expect(legs.filter((leg) => leg.kind === "payment").length).toBe(1);
  });

  test("is idempotent — a second run writes nothing", async () => {
    const listing = await createTestListing({ maxAttendees: 5 });
    await historicalBooking([{ listingId: listing.id, pricePaid: 5000 }]);
    await backfillTransfers("GBP");
    const after = (await allTransfers()).length;
    await backfillTransfers("GBP");
    expect((await allTransfers()).length).toBe(after);
  });

  test("reverses a fully-refunded booking back to zero revenue", async () => {
    const listing = await createTestListing({ maxAttendees: 5 });
    const attendee = await historicalBooking([
      { listingId: listing.id, pricePaid: 5000 },
    ]);
    await markRefunded(attendee.id, listing.id);

    await backfillTransfers("GBP");

    expect(await accountBalance(revenueAccount(listing.id))).toBe(0); // reversed
    expect(await accountBalance(attendeeAccount(attendee.id))).toBe(0);
    const cash = refundCashOf(
      await transfersByAccount(attendeeAccount(attendee.id)),
    );
    expect(cash.length).toBe(1);
    expect(cash[0]!.amount).toBe(5000);
    expect(cash[0]!.destination).toEqual(WORLD);
  });

  test("does not reverse a partially-refunded multi-listing order", async () => {
    // The data guarantees this can't occur, but a half-refunded order must not
    // be reversed: leave it booked for a manual check rather than mis-reverse.
    const first = await createTestListing({ maxAttendees: 5 });
    const second = await createTestListing({ maxAttendees: 5 });
    const attendee = await historicalBooking([
      { listingId: first.id, pricePaid: 3000 },
      { listingId: second.id, pricePaid: 2000 },
    ]);
    await markRefunded(attendee.id, first.id); // only one line refunded

    await backfillTransfers("GBP");

    // Still booked: revenue recognised, nothing reversed.
    expect(await accountBalance(revenueAccount(first.id))).toBe(3000);
    expect(await accountBalance(revenueAccount(second.id))).toBe(2000);
    expect(
      refundCashOf(await transfersByAccount(attendeeAccount(attendee.id)))
        .length,
    ).toBe(0);
  });

  test("skips rows with no payment", async () => {
    const listing = await createTestListing({ maxAttendees: 5 });
    await historicalBooking([{ listingId: listing.id, pricePaid: 0 }]);
    await backfillTransfers("GBP");
    expect((await allTransfers()).length).toBe(0);
  });

  test("throws on an unparseable booking time rather than guessing", async () => {
    const listing = await createTestListing({ maxAttendees: 5 });
    const attendee = await historicalBooking([
      { listingId: listing.id, pricePaid: 5000 },
    ]);
    await getDb().execute({
      args: [attendee.id],
      sql: "UPDATE attendees SET created = 'not a date' WHERE id = ?",
    });

    await expect(backfillTransfers("GBP")).rejects.toThrow(
      "unparseable created time",
    );
  });
});
