import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { queryOne } from "#db/client.ts";
import {
  adjustListingIncome,
  getListingAggregateRecalculation,
  listingAggregates,
} from "#db/listings/aggregates.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createListingWithDriftedTotals,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";

const storedTotals = (listingId: number) =>
  queryOne<{ booked_quantity: number; tickets_count: number }>(
    "SELECT booked_quantity, tickets_count FROM listings WHERE id = ?",
    [listingId],
  );

describeWithEnv("db > listing aggregates", { db: true }, () => {
  describe("getListingAggregateRecalculation", () => {
    test("pairs each stored total with the one rebuilt from bookings", async () => {
      const listing = await createListingWithDriftedTotals();
      const withCount = await getListingWithCount(listing.id);
      const recalculation = await getListingAggregateRecalculation(
        // biome-ignore lint/style/noNonNullAssertion: the listing was just created
        withCount!,
      );
      expect(recalculation).toEqual({
        booked_quantity: { current: 9, recalculated: 1 },
        tickets_count: { current: 5, recalculated: 1 },
      });
    });

    test("reads zero from a listing nobody booked", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const withCount = await getListingWithCount(listing.id);
      // biome-ignore lint/style/noNonNullAssertion: the listing was just created
      const recalculation = await getListingAggregateRecalculation(withCount!);
      expect(recalculation.booked_quantity.recalculated).toBe(0);
      expect(recalculation.tickets_count.recalculated).toBe(0);
    });
  });

  describe("listingAggregates.update", () => {
    test("writes every editable total, and only for the named listing", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const other = await createTestListing({ maxAttendees: 10 });
      await listingAggregates.update(listing.id, {
        booked_quantity: 7,
        tickets_count: 3,
      });
      expect(await storedTotals(listing.id)).toEqual({
        booked_quantity: 7,
        tickets_count: 3,
      });
      expect(await storedTotals(other.id)).toEqual({
        booked_quantity: 0,
        tickets_count: 0,
      });
    });
  });

  describe("listingAggregates.reset", () => {
    test("rebuilds only the named column", async () => {
      const listing = await createListingWithDriftedTotals();
      await listingAggregates.reset(listing.id, ["booked_quantity"]);
      expect(await storedTotals(listing.id)).toEqual({
        booked_quantity: 1,
        tickets_count: 5,
      });
    });

    test("rebuilds every column when all are named", async () => {
      const listing = await createListingWithDriftedTotals();
      await listingAggregates.reset(listing.id, [
        "booked_quantity",
        "tickets_count",
      ]);
      expect(await storedTotals(listing.id)).toEqual({
        booked_quantity: 1,
        tickets_count: 1,
      });
    });

    test("changes nothing when no column is named", async () => {
      const listing = await createListingWithDriftedTotals();
      await listingAggregates.reset(listing.id, []);
      expect(await storedTotals(listing.id)).toEqual({
        booked_quantity: 9,
        tickets_count: 5,
      });
    });
  });

  describe("adjustListingIncome", () => {
    test("moves projected income to the requested amount", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      await adjustListingIncome(listing.id, 2500);
      expect((await getListingWithCount(listing.id))?.income).toBe(2500);
    });

    test("is a no-op when the income already matches", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      await adjustListingIncome(listing.id, 2500);
      await adjustListingIncome(listing.id, 2500);
      expect((await getListingWithCount(listing.id))?.income).toBe(2500);
    });
  });
});
