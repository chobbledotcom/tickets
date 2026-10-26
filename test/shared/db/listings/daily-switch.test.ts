import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeesApi } from "#db/attendees/api.ts";
import { type TxScope, withTransaction } from "#db/client.ts";
import {
  moveUndatedBookingsToDayTx,
  refuseUndatedSwitchTx,
  undatedBookingsForListing,
  wouldBeStaySpanDays,
} from "#db/listings/daily-switch.ts";
import { TransactionValidationError } from "#db/transaction.ts";
import { t } from "#i18n";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import { expectListingActivityLogContains } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import type { ListingWithCount } from "#types";

const input = (overrides: Partial<ListingInput> = {}): ListingInput =>
  ({
    customisableDays: false,
    durationDays: 3,
    listingType: "daily",
    name: "Hall",
    ...overrides,
  }) as ListingInput;

/** The booking rows of one listing, with their day windows. */
const rawRows = async (
  listingId: number,
): Promise<
  { attendee_id: number; end_at: string | null; start_at: string | null }[]
> => {
  const { queryAll } = await import("#db/client.ts");
  return queryAll(
    "SELECT attendee_id, end_at, start_at FROM listing_attendees WHERE listing_id = ? ORDER BY attendee_id",
    [listingId],
  );
};

/** A listing with two undated bookings: one row of 2, one row of 3. */
const listingWithTwoUndatedBookings = async (): Promise<ListingWithCount> => {
  const listing = await createTestListing({ maxAttendees: 10 });
  await bookAttendee(listing, { quantity: 2 });
  await bookAttendee(listing, {
    email: "y@example.com",
    name: "Y",
    quantity: 3,
  });
  return listing;
};

describeWithEnv("db: listings — the daily switch", { db: true }, () => {
  test("wouldBeStaySpanDays takes one day when customers pick their own", () => {
    expect(wouldBeStaySpanDays(input({ customisableDays: true }))).toBe(1);
    expect(wouldBeStaySpanDays(input({ durationDays: 3 }))).toBe(3);
  });

  test("a quantity-0 ghost line alone never trips the undated guard", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    await attendeesApi.createAttendeeAtomic({
      bookings: [{ listingId: listing.id, quantity: 0 }],
      email: "ghost@example.com",
      name: "Ghost",
    });
    await withTransaction(async (tx) => {
      const refusal = await refuseUndatedSwitchTx(tx, listing.id, "daily");
      expect(refusal).toBeNull();
    });
  });

  test("a move on a listing with no undated bookings dates nothing and returns zero", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    await bookAttendee(listing, { date: "2026-10-01", quantity: 2 });
    const moved = await withTransaction((tx) =>
      moveUndatedBookingsToDayTx(tx, listing.id, listing.name, "2026-11-05", 1),
    );
    expect(moved).toBe(0);
    const rows = await rawRows(listing.id);
    expect(rows[0]!.start_at).toBe("2026-10-01T00:00:00Z");
  });

  test("a batch failure that is not the capacity guard propagates untouched", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    await bookAttendee(listing, { quantity: 2 });
    const failingTx: TxScope = {
      batch: () => Promise.reject(new Error("the database stopped responding")),
      execute: () =>
        Promise.reject(new Error("the database stopped responding")),
    };
    const failure = await withTransaction(async () => {
      try {
        await moveUndatedBookingsToDayTx(
          failingTx,
          listing.id,
          listing.name,
          "2026-11-05",
          1,
        );
        return null;
      } catch (error) {
        return error;
      }
    });
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toHaveProperty(
      "message",
      "the database stopped responding",
    );
  });

  test("a committed two-row move logs the plural count", async () => {
    const listing = await listingWithTwoUndatedBookings();
    await withTransaction((tx) =>
      moveUndatedBookingsToDayTx(tx, listing.id, listing.name, "2026-11-05", 1),
    );
    await expectListingActivityLogContains(
      listing.id,
      "moved 2 bookings to 2026-11-05",
    );
  });

  test("undatedBookingsForListing reads the rows a switch must date", async () => {
    const listing = await listingWithTwoUndatedBookings();
    // A dated row and a quantity-0 ghost line are neither of them undated
    // bookings: one already holds a day, the other books nothing.
    await bookAttendee(listing, {
      date: "2026-10-01",
      email: "z@example.com",
      name: "Z",
    });
    await attendeesApi.createAttendeeAtomic({
      bookings: [{ listingId: listing.id, quantity: 0 }],
      email: "ghost@example.com",
      name: "Ghost",
    });

    const undated = await undatedBookingsForListing(listing.id);
    expect(undated).toHaveLength(2);
    expect(undated.map((row) => row.quantity).sort()).toEqual([2, 3]);
    expect((await rawRows(listing.id)).length).toBe(4);
  });

  test("moveUndatedBookingsToDayTx dates every row under the stay span", async () => {
    const listing = await listingWithTwoUndatedBookings();
    const moved = await withTransaction((tx) =>
      moveUndatedBookingsToDayTx(tx, listing.id, listing.name, "2026-11-05", 2),
    );
    expect(moved).toBe(2);
    const rows = await rawRows(listing.id);
    for (const row of rows) {
      expect(row.start_at).toBe("2026-11-05T00:00:00Z");
      expect(row.end_at).toBe("2026-11-07T00:00:00.000Z");
    }
  });

  test("a move onto a full day refuses and writes nothing", async () => {
    const listing = await createTestListing({ maxAttendees: 2 });
    await bookAttendee(listing, { quantity: 2 });
    const { queryAll } = await import("#db/client.ts");
    // Widen the cap for the setup booking, then take it away again: the day
    // the move targets can hold none of the undated bookings.
    await queryAll("UPDATE listings SET max_attendees = 3 WHERE id = ?", [
      listing.id,
    ]);
    await bookAttendee(listing, {
      date: "2026-11-05",
      email: "z@example.com",
      name: "Z",
    });
    await queryAll("UPDATE listings SET max_attendees = 2 WHERE id = ?", [
      listing.id,
    ]);

    const refusal = await withTransaction(async (tx) => {
      try {
        await moveUndatedBookingsToDayTx(
          tx,
          listing.id,
          listing.name,
          "2026-11-05",
          1,
        );
        return null;
      } catch (error) {
        if (error instanceof TransactionValidationError) return error.message;
        throw error;
      }
    });
    expect(refusal).toBe(
      t("listings_table.switch_daily_undated_refused", {
        count: 2,
        date: "2026-11-05",
        name: listing.name,
      }),
    );
    const rows = await rawRows(listing.id);
    // The refused move left the one undated booking alone: still no day, and
    // the dated booking still holds the day it held.
    const undated = rows.filter((row) => row.start_at === null);
    expect(undated).toHaveLength(1);
    expect(
      rows.filter((row) => row.start_at === "2026-11-05T00:00:00Z"),
    ).toHaveLength(1);
  });

  test("refuseUndatedSwitchTx refuses a bare switch and passes everything else", async () => {
    const listing: ListingWithCount = await createTestListing({
      maxAttendees: 2,
    });
    await bookAttendee(listing, { quantity: 1 });

    // An ordinary save of a standard listing is never the gate's business.
    const standard = await withTransaction((tx) =>
      refuseUndatedSwitchTx(tx, listing.id, "standard"),
    );
    expect(standard).toBeNull();

    const refusal = await withTransaction((tx) =>
      refuseUndatedSwitchTx(tx, listing.id, "daily"),
    );
    expect(refusal).toBe(
      t("listings_table.switch_daily_undated_guard", { count: 1 }),
    );

    // The same listing already daily is not a switch at all.
    await withTransaction(async (tx) => {
      await tx.execute({
        args: [listing.id],
        sql: "UPDATE listings SET listing_type = 'daily' WHERE id = ?",
      });
    });
    const daily = await withTransaction((tx) =>
      refuseUndatedSwitchTx(tx, listing.id, "daily"),
    );
    expect(daily).toBeNull();
  });

  test("a committed move logs the exact count inside its transaction", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    await bookAttendee(listing, { quantity: 2 });
    await withTransaction((tx) =>
      moveUndatedBookingsToDayTx(tx, listing.id, listing.name, "2026-11-05", 1),
    );
    await expectListingActivityLogContains(
      listing.id,
      "moved 1 booking to 2026-11-05",
    );
  });
});
