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
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#shared/db/query-log.ts";
import type { Transfer } from "#shared/ledger/types.ts";
import { createTestListing, describeWithEnv } from "#test-utils";
import {
  seedPreDropLedgerColumns,
  stampHistoricalPricePaid,
} from "../db/migration-test-helpers.ts";

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

/** Create a historical paid booking with NO ledger legs (pre-dual-write). The
 *  email is overridable so a test can seed many distinct historical attendees. */
const historicalBooking = async (
  bookings: ListingBooking[],
  email = "a@b.c",
) => {
  const result = await createAttendeeAtomic({
    bookings,
    email,
    name: "Historical",
  });
  if (!result.success) throw new Error(`setup failed: ${result.reason}`);
  const attendee = result.attendees[0]!;
  // A pre-ledger row carried its amount in the price_paid column — the backfill's
  // only source. createAttendeeAtomic no longer writes it (amounts live in the
  // ledger now), so stamp the restored column directly to reproduce that history.
  for (const booking of bookings) {
    await stampHistoricalPricePaid(
      attendee.id,
      booking.listingId,
      booking.pricePaid ?? 0,
    );
  }
  return attendee;
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
  beforeEach(seedPreDropLedgerColumns);

  test("reconstructs sale + payment for a paid booking", async () => {
    const listing = await createTestListing({ maxAttendees: 5 });
    const attendee = await historicalBooking([
      { listingId: listing.id, pricePaid: 5000 },
    ]);
    expect((await allTransfers()).length).toBe(0); // no legs yet

    await backfillTransfers();

    expect(await accountBalance(revenueAccount(listing.id))).toBe(5000);
    expect(await accountBalance(attendeeAccount(attendee.id))).toBe(0); // paid full
    expect(await accountBalance(WORLD)).toBe(-5000); // cash in
  });

  test("stamps each row's ledger_event_group with its booking event group", async () => {
    // The per-row amount-paid projection keys on ledger_event_group, so the
    // backfill must stamp it with the order's booking event group (the sale leg's).
    const listing = await createTestListing({ maxAttendees: 5 });
    const attendee = await historicalBooking([
      { listingId: listing.id, pricePaid: 5000 },
    ]);
    await backfillTransfers();

    const sale = (await transfersByAccount(attendeeAccount(attendee.id))).find(
      (leg) => leg.kind === "sale",
    )!;
    expect(sale.eventGroup).not.toBe("");
    const row = (
      await getDb().execute({
        args: [attendee.id],
        sql: "SELECT ledger_event_group FROM listing_attendees WHERE attendee_id = ?",
      })
    ).rows[0]!;
    expect(String(row.ledger_event_group)).toBe(sale.eventGroup);
  });

  test("groups a multi-listing booking into one order (sales + one payment)", async () => {
    const first = await createTestListing({ maxAttendees: 5 });
    const second = await createTestListing({ maxAttendees: 5 });
    const attendee = await historicalBooking([
      { listingId: first.id, pricePaid: 3000 },
      { listingId: second.id, pricePaid: 2000 },
    ]);

    await backfillTransfers();

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
    await backfillTransfers();
    const after = (await allTransfers()).length;
    await backfillTransfers();
    expect((await allTransfers()).length).toBe(after);
  });

  test("reverses a fully-refunded booking back to zero revenue", async () => {
    const listing = await createTestListing({ maxAttendees: 5 });
    const attendee = await historicalBooking([
      { listingId: listing.id, pricePaid: 5000 },
    ]);
    await flagRefunded(attendee.id, listing.id);

    await backfillTransfers();

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

    await backfillTransfers();

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

    await backfillTransfers();

    expect((await allTransfers()).length).toBe(before); // nothing re-posted
    const legs = await transfersByAccount(attendeeAccount(attendee.id));
    const groups = new Set(legs.map((leg) => leg.eventGroup));
    expect(groups.size).toBe(1); // only the live booking group, no backfill group
    // Deploy-order robustness: the already-ledgered branch still stamps the
    // row→event link from the existing sale leg, so the per-row amount-paid
    // projection resolves even though no legs were re-posted.
    const sale = legs.find((leg) => leg.kind === "sale")!;
    const row = (
      await getDb().execute({
        args: [attendee.id],
        sql: "SELECT ledger_event_group FROM listing_attendees WHERE attendee_id = ?",
      })
    ).rows[0]!;
    expect(String(row.ledger_event_group)).toBe(sale.eventGroup);
  });

  test("posts a page of attendees in a bounded number of round-trips", async () => {
    // Regression: the backfill once issued one write batch per attendee, so a
    // real site's booking history blew the Bunny edge isolate's subrequest budget
    // mid-migration — the isolate was evicted with the migration lock still held,
    // turning into endless 503s. A page must cost O(1) round-trips, not O(N).
    const listing = await createTestListing({ maxAttendees: 50 });
    const attendeeCount = 12;
    for (let i = 0; i < attendeeCount; i++) {
      await historicalBooking(
        [{ listingId: listing.id, pricePaid: 1000 + i }],
        `att${i}@b.c`,
      );
    }

    await runWithQueryLogContext(async () => {
      enableQueryLog();
      await backfillTransfers();
      // Every statement in one batch shares its round-trip's start timestamp, so
      // distinct start times count round-trips. A page is a few reads plus one
      // packed write batch — far below the 12 a per-attendee batch would cost.
      const roundTrips = new Set(getQueryLog().map((q) => q.startedAtMs)).size;
      expect(roundTrips).toBeLessThanOrEqual(6);
    });
  });

  test("skips rows with no payment", async () => {
    const listing = await createTestListing({ maxAttendees: 5 });
    await historicalBooking([{ listingId: listing.id, pricePaid: 0 }]);
    await backfillTransfers();
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

    await expect(backfillTransfers()).rejects.toThrow(
      "unparseable created time",
    );
  });
});
