import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  revenueAccount,
  WORLD,
} from "#shared/accounting/accounts.ts";
import { backfillTransfers } from "#shared/accounting/backfill.ts";
import { type BookingFacts, mapBooking } from "#shared/accounting/mappers.ts";
import {
  accountBalance,
  allTransfers,
  transfersByAccount,
} from "#shared/accounting/queries.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import type { ListingBooking } from "#shared/db/attendee-types.ts";
import { createAttendeeAtomic } from "#shared/db/attendees.ts";
import { getDb } from "#shared/db/client.ts";
import type { Transfer } from "#shared/ledger/types.ts";
import { createTestListing, describeWithEnv } from "#test-utils";

/**
 * Recreate the legacy `listing_attendees.refunded` column. The backfill runs as
 * the `2026-06-22_backfill_transfers` migration — BEFORE
 * `2026-06-22_drop_listing_attendee_refunded` — so in production it reads the
 * column while it still exists. The test DB is built from the current (post-drop)
 * SCHEMA, so restore the column to reproduce the schema the backfill really runs
 * against, just as the income-drop migration's own test restores `listings.income`.
 */
const seedPreDropRefundedColumn = async (): Promise<void> => {
  await getDb().execute(
    "ALTER TABLE listing_attendees ADD COLUMN refunded INTEGER NOT NULL DEFAULT 0",
  );
};

/** Flag a historical booking line refunded, the way a pre-ledger DB recorded a
 *  provider refund before the column was projected from the ledger. */
const flagRefunded = (
  attendeeId: number,
  listingId: number,
): Promise<unknown> =>
  getDb().execute({
    args: [attendeeId, listingId],
    sql: "UPDATE listing_attendees SET refunded = 1 WHERE attendee_id = ? AND listing_id = ?",
  });

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

/** Post one live-style booking leg-set, as the dual-write path would have. */
const postLiveBooking = async (
  overrides: Partial<BookingFacts>,
): Promise<void> => {
  await postTransfers(
    await mapBooking({
      amountPaid: 5000,
      attendeeId: 1,
      bookingFee: 0,
      currency: "GBP",
      eventId: "live-session",
      lines: [{ gross: 5000, listingId: 1 }],
      modifiers: [],
      occurredAt: "2026-06-21T00:00:00.000Z",
      ...overrides,
    }),
  );
};

const refundCashOf = (legs: Transfer[]): Transfer[] =>
  legs.filter((leg) => leg.kind === "refund_cash");

describeWithEnv("accounting > backfill", { db: true }, () => {
  // The backfill reads listing_attendees.refunded, which a later migration drops;
  // restore it so each test exercises the schema the migration runs against.
  beforeEach(seedPreDropRefundedColumn);

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
    await flagRefunded(attendee.id, listing.id);

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

  test("reverses the whole order when any line is flagged refunded", async () => {
    // A multi-listing order is one provider payment; refunding it returns the
    // whole payment, but a historical refund flagged only the listing the admin
    // acted on. Any flagged line therefore means the whole order was refunded.
    const first = await createTestListing({ maxAttendees: 5 });
    const second = await createTestListing({ maxAttendees: 5 });
    const attendee = await historicalBooking([
      { listingId: first.id, pricePaid: 3000 },
      { listingId: second.id, pricePaid: 2000 },
    ]);
    await flagRefunded(attendee.id, first.id); // one line flagged → whole order

    await backfillTransfers("GBP");

    expect(await accountBalance(revenueAccount(first.id))).toBe(0); // reversed
    expect(await accountBalance(revenueAccount(second.id))).toBe(0); // reversed
    expect(await accountBalance(attendeeAccount(attendee.id))).toBe(0);
    const cash = refundCashOf(
      await transfersByAccount(attendeeAccount(attendee.id)),
    );
    expect(cash.length).toBe(1);
    expect(cash[0]!.amount).toBe(5000); // the whole payment returned
  });

  test("skips an attendee that already carries ledger legs (no double-post)", async () => {
    const listing = await createTestListing({ maxAttendees: 5 });
    const attendee = await historicalBooking([
      { listingId: listing.id, pricePaid: 5000 },
    ]);
    // The live dual-write path already recorded this booking under its own event.
    await postLiveBooking({
      attendeeId: attendee.id,
      lines: [{ gross: 5000, listingId: listing.id }],
    });
    const before = (await allTransfers()).length;

    await backfillTransfers("GBP");

    expect((await allTransfers()).length).toBe(before); // nothing re-posted
    const groups = new Set(
      (await transfersByAccount(attendeeAccount(attendee.id))).map(
        (leg) => leg.eventGroup,
      ),
    );
    expect(groups.size).toBe(1); // only the live booking group, no backfill group
  });

  test("posts in the currency the ledger already holds, not the requested one", async () => {
    // An existing USD leg fixes the ledger currency for an unrelated attendee.
    const occupied = await createTestListing({ maxAttendees: 5 });
    const ledgered = await historicalBooking([
      { listingId: occupied.id, pricePaid: 1000 },
    ]);
    await postLiveBooking({
      amountPaid: 1000,
      attendeeId: ledgered.id,
      currency: "USD",
      eventId: "live-usd",
      lines: [{ gross: 1000, listingId: occupied.id }],
    });
    // A fresh attendee (no legs) is backfilled despite the requested GBP.
    const listing = await createTestListing({ maxAttendees: 5 });
    const fresh = await historicalBooking([
      { listingId: listing.id, pricePaid: 2000 },
    ]);

    await backfillTransfers("GBP");

    const legs = await transfersByAccount(attendeeAccount(fresh.id));
    expect(legs.length).toBeGreaterThan(0);
    expect(legs.every((leg) => leg.currency === "USD")).toBe(true);
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
