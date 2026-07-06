import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { decryptAttendees } from "#shared/db/attendees.ts";
import { execute } from "#shared/db/client.ts";
import { getListingOverviewStats } from "#shared/db/listing-overview-stats.ts";
import {
  getAttendeesByListingIds,
  getListingWithCount,
  listingRevenueBreakdown,
} from "#shared/db/listings.ts";
import { isPaidListing } from "#shared/types.ts";
import {
  overviewStatsFromAttendees,
  overviewStatsFromDbStats,
} from "#templates/admin/listings/overview.tsx";
import {
  createPaidAttendeeWithoutLedger,
  createPaidTestAttendee,
  createTestListing,
  describeWithEnv,
  getTestPrivateKey,
} from "#test-utils";
import { postListingSale } from "#test-utils/ledger.ts";

const checkIn = (attendeeId: number, listingId: number): Promise<unknown> =>
  execute(
    "UPDATE listing_attendees SET checked_in = 1 WHERE attendee_id = ? AND listing_id = ?",
    [attendeeId, listingId],
  );

/** The listing-with-count plus the attendee-derived reference stats the SQL
 *  path must reproduce — loads and decrypts the real attendee rows. */
const referenceFor = async (listingId: number) => {
  const withCount = (await getListingWithCount(listingId))!;
  const raw = await getAttendeesByListingIds([listingId]);
  const decrypted = await decryptAttendees(raw, await getTestPrivateKey());
  return {
    reference: overviewStatsFromAttendees(withCount, decrypted),
    withCount,
  };
};

/** Post a recognised sale with no payment ever received — the ledger signature
 *  of an abandoned/incomplete checkout (a `sale` leg, no `payment` leg). */
const postIncompleteSale = (
  attendeeId: number,
  listingId: number,
  gross: number,
): Promise<void> =>
  postListingSale({ amountPaid: 0, attendeeId, gross, listingId });

describeWithEnv("db > listing-overview-stats", { db: true }, () => {
  test("matches the attendee-derived reference across payment states", async () => {
    const listing = await createTestListing({
      maxAttendees: 100,
      unitPrice: 500,
    });
    // A1: paid in full (sale + payment), qty 1, checked in.
    const a1 = await createPaidTestAttendee(
      listing.id,
      "A1",
      "a1@example.com",
      "pi_a1",
      500,
      1,
    );
    await checkIn(a1.id, listing.id);
    // A2: paid in full, qty 2, not checked in.
    await createPaidTestAttendee(
      listing.id,
      "A2",
      "a2@example.com",
      "pi_a2",
      500,
      2,
    );
    // A3: incomplete — a recognised sale but no payment linked, empty payment id.
    const a3 = await createPaidAttendeeWithoutLedger(
      listing.id,
      "A3",
      "a3@example.com",
      "",
      300,
      1,
    );
    await postIncompleteSale(a3.id, listing.id, 300);
    // A4: deposit — a full sale but only part paid (owes a balance), qty 1,
    // checked in. It keeps its payment leg + payment id, so it is NOT incomplete.
    const a4 = await createPaidAttendeeWithoutLedger(
      listing.id,
      "A4",
      "a4@example.com",
      "pi_a4",
      800,
      1,
    );
    await postListingSale({
      amountPaid: 400,
      attendeeId: a4.id,
      gross: 800,
      listingId: listing.id,
    });
    await checkIn(a4.id, listing.id);
    // A5: admin comp — no sale leg (price 0), so never "incomplete".
    await createPaidAttendeeWithoutLedger(
      listing.id,
      "A5",
      "a5@example.com",
      "",
      0,
      1,
    );

    const { withCount, reference } = await referenceFor(listing.id);
    const stats = await getListingOverviewStats(listing);
    const { grossSales } = await listingRevenueBreakdown(listing.id);

    // Exact expected figures for the seeded scenario.
    expect(stats.incompleteQuantity).toBe(1); // A3
    expect(stats.completeQuantitySum).toBe(5); // A1+A2+A4+A5 = 1+2+1+1
    expect(stats.ticketsTotal).toBe(5);
    expect(stats.rowsTotal).toBe(4);
    expect(stats.ticketsCheckedIn).toBe(2); // A1 + A4
    expect(stats.rowsCheckedIn).toBe(2);
    expect(stats.incompleteSales).toBe(300); // A3's unpaid sale
    expect(grossSales).toBe(2100); // 500 + 500 + 300 + 800

    // …and the assembled view reproduces the attendee-derived reference exactly.
    const view = overviewStatsFromDbStats(
      stats,
      withCount.attendee_count,
      grossSales,
      isPaidListing(withCount),
    );
    expect(view).toEqual(reference);
    expect(view.adjustedCount).toBe(5); // 6 booked − 1 incomplete
    expect(view.completeRevenue).toBe(1800); // 2100 gross − 300 unpaid
  });

  test("counts nothing incomplete and skips the ledger scan for a free listing", async () => {
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 0,
    });
    await createPaidTestAttendee(listing.id, "F1", "f1@example.com", "", 0, 3);

    const stats = await getListingOverviewStats(listing);
    expect(stats.incompleteQuantity).toBe(0);
    expect(stats.incompleteSales).toBe(0);
    expect(stats.completeQuantitySum).toBe(3);
    expect(stats.ticketsTotal).toBe(3);
    expect(stats.rowsTotal).toBe(1);

    const { withCount, reference } = await referenceFor(listing.id);
    const view = overviewStatsFromDbStats(
      stats,
      withCount.attendee_count,
      0,
      isPaidListing(withCount),
    );
    expect(view).toEqual(reference);
    expect(view.completeRevenue).toBe(0);
  });

  test("ignores servicing rows and other listings' bookings", async () => {
    const other = await createTestListing({ maxAttendees: 10, unitPrice: 500 });
    await createPaidTestAttendee(
      other.id,
      "Other",
      "o@example.com",
      "pi_o",
      500,
      1,
    );
    const listing = await createTestListing({
      maxAttendees: 10,
      unitPrice: 500,
    });
    await createPaidTestAttendee(
      listing.id,
      "Mine",
      "m@example.com",
      "pi_m",
      500,
      1,
    );

    const stats = await getListingOverviewStats(listing);
    expect(stats.completeQuantitySum).toBe(1);
    expect(stats.incompleteQuantity).toBe(0);
  });
});
