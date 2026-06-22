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
import { createAttendeeAtomic, markRefunded } from "#shared/db/attendees.ts";
import { createTestListing, describeWithEnv } from "#test-utils";

/** Create a historical paid booking with NO ledger legs (pre-dual-write). */
const historicalBooking = async (listingId: number, pricePaid: number) => {
  const result = await createAttendeeAtomic({
    bookings: [{ listingId, pricePaid }],
    email: "a@b.c",
    name: "Historical",
  });
  if (!result.success) throw new Error(`setup failed: ${result.reason}`);
  return result.attendees[0]!;
};

describeWithEnv("accounting > backfill", { db: true }, () => {
  test("reconstructs sale + payment for a paid booking", async () => {
    const listing = await createTestListing({ maxAttendees: 5 });
    const attendee = await historicalBooking(listing.id, 5000);
    expect((await allTransfers()).length).toBe(0); // no legs yet

    await backfillTransfers("GBP");

    expect(await accountBalance(revenueAccount(listing.id))).toBe(5000);
    expect(await accountBalance(attendeeAccount(attendee.id))).toBe(0); // paid full
    expect(await accountBalance(WORLD)).toBe(-5000); // cash in
  });

  test("is idempotent — a second run writes nothing", async () => {
    const listing = await createTestListing({ maxAttendees: 5 });
    await historicalBooking(listing.id, 5000);
    await backfillTransfers("GBP");
    const after = (await allTransfers()).length;
    await backfillTransfers("GBP");
    expect((await allTransfers()).length).toBe(after);
  });

  test("reverses a refunded booking back to zero revenue", async () => {
    const listing = await createTestListing({ maxAttendees: 5 });
    const attendee = await historicalBooking(listing.id, 5000);
    await markRefunded(attendee.id, listing.id);

    await backfillTransfers("GBP");

    expect(await accountBalance(revenueAccount(listing.id))).toBe(0); // reversed
    expect(await accountBalance(attendeeAccount(attendee.id))).toBe(0);
    const cash = (
      await transfersByAccount(attendeeAccount(attendee.id))
    ).filter((l) => l.kind === "refund_cash");
    expect(cash.length).toBe(1);
    expect(cash[0]!.amount).toBe(5000);
  });

  test("skips rows with no payment", async () => {
    const listing = await createTestListing({ maxAttendees: 5 });
    await historicalBooking(listing.id, 0); // price_paid 0 → excluded
    await backfillTransfers("GBP");
    expect((await allTransfers()).length).toBe(0);
  });
});
