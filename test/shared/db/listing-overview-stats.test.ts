import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeAccount, WORLD } from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import { listingMoneyTotals } from "#accounting/listing-money-totals.ts";
import { emptyRange } from "#accounting/range.ts";
import { postTransfers } from "#accounting/store.ts";
import { balanceEventGroup } from "#db/attendees/balance.ts";
import { decryptAttendees } from "#db/attendees/pii.ts";
import { execute } from "#db/client.ts";
import { getListingOverviewStats } from "#db/listing-overview-stats.ts";
import { getAttendeesByListingIds } from "#db/listings/attendees.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { reserveSession } from "#db/processed-payments.ts";
import { sql } from "#db/sql.ts";
import type { AccountRef } from "#shared/ledger/types.ts";
import {
  overviewStatsFromAttendees,
  overviewStatsFromDbStats,
} from "#templates/admin/listings/overview.tsx";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createPaidAttendeeWithoutLedger,
  createPaidTestAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { createListingPair } from "#test-utils/db-helpers/listing-pair.ts";
import { createPricedListing } from "#test-utils/db-helpers/priced-listing.ts";
import { postListingSale, postWriteoffAdjustment } from "#test-utils/ledger.ts";
import {
  finalizeReservedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";
import { type Attendee, isPaidListing, type ListingWithCount } from "#types";

const checkIn = (attendeeId: number, listingId: number): Promise<unknown> =>
  execute(
    sql`UPDATE listing_attendees SET checked_in = 1 WHERE attendee_id = ${attendeeId} AND listing_id = ${listingId}`,
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
const postIncompleteSale = async (
  attendeeId: number,
  listingId: number,
  gross: number,
): Promise<void> => {
  await postListingSale({ amountPaid: 0, attendeeId, gross, listingId });
};

/** One payment leg received by `destination` under `eventGroup`. */
const postPaymentLeg = async (
  destination: AccountRef,
  eventGroup: string,
  reference: string,
): Promise<void> => {
  await postTransfers([
    {
      amount: 500,
      destination,
      eventGroup,
      kind: KIND.payment,
      occurredAt: "2026-06-21T00:00:00.000Z",
      reference,
      source: WORLD,
    },
  ]);
};

/** A priced listing holding one attendee whose booking-group sale received no
 *  payment, so the sale reads incomplete until a payment lands in its group. */
const setupUnpaidSale = async (
  name: string,
  email: string,
): Promise<{ attendee: Attendee; listing: ListingWithCount }> => {
  const listing = await createPricedListing({ maxAttendees: 50 });
  const attendee = await createPaidAttendeeWithoutLedger(
    listing.id,
    name,
    email,
    "",
  );
  await postIncompleteSale(attendee.id, listing.id, 500);
  return { attendee, listing };
};

describeWithEnv("db > listing-overview-stats", { db: true }, () => {
  test("matches the attendee-derived reference across payment states", async () => {
    const listing = await createPricedListing({ maxAttendees: 100 });
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
    await postWriteoffAdjustment(attendeeAccount(a3.id), 300, [
      "clear-incomplete",
      a3.id,
    ]);
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
    const { grossSales } = await listingMoneyTotals(emptyRange, [listing.id]);

    // Exact expected figures for the seeded scenario: A3's unpaid sale keeps
    // one booking out of the complete split; A1 and A4 are checked in.
    expect(stats).toMatchObject({
      completeQuantitySum: 5,
      incompleteQuantity: 1,
      incompleteSales: 300,
      rowsCheckedIn: 2,
      rowsTotal: 4,
      ticketsCheckedIn: 2,
      ticketsTotal: 5,
    });
    expect(grossSales).toBe(2100); // 500 + 500 + 300 + 800

    // …and the assembled view reproduces the attendee-derived reference exactly.
    const view = overviewStatsFromDbStats(
      stats,
      withCount.attendee_count,
      grossSales,
      isPaidListing(withCount),
    );
    expect(view).toEqual(reference);
    expect(view).toMatchObject({ adjustedCount: 5, completeRevenue: 1800 });
  });

  test("counts nothing incomplete and skips the ledger scan for a free listing", async () => {
    const listing = await createPricedListing({
      maxAttendees: 50,
      unitPrice: 0,
    });
    await createPaidTestAttendee(listing.id, "F1", "f1@example.com", "", 0, 3);

    const stats = await getListingOverviewStats(listing);
    expect(stats).toMatchObject({
      completeQuantitySum: 3,
      incompleteQuantity: 0,
      incompleteSales: 0,
      rowsTotal: 1,
      ticketsTotal: 3,
    });

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

  test("does not mark an empty-payment-id attendee incomplete once a processed payment reference exists", async () => {
    const { attendee, listing } = await setupUnpaidSale(
      "Balance Paid",
      "balance-paid@example.com",
    );
    await postPaymentLeg(
      attendeeAccount(attendee.id),
      await balanceEventGroup("overview_balance_paid"),
      "overview-balance-payment",
    );
    await reserveSession("overview_balance_paid");
    await finalizeReservedPayment(
      "overview_balance_paid",
      attendee.id,
      "",
      taggedPaymentReference("pi_overview_balance_paid"),
    );

    const stats = await getListingOverviewStats(listing);
    expect(stats).toMatchObject({
      completeQuantitySum: 1,
      incompleteQuantity: 0,
      incompleteSales: 0,
    });
  });

  test("ignores servicing rows and other listings' bookings", async () => {
    const [other, listing] = await createListingPair({
      maxAttendees: 10,
      unitPrice: 500,
    });
    await createPaidTestAttendee(
      other.id,
      "Other",
      "o@example.com",
      "pi_o",
      500,
      1,
    );
    await createPaidTestAttendee(
      listing.id,
      "Mine",
      "m@example.com",
      "pi_m",
      500,
      1,
    );

    const stats = await getListingOverviewStats(listing);
    expect(stats).toMatchObject({
      completeQuantitySum: 1,
      incompleteQuantity: 0,
    });
  });

  test("a balance payment does not pay an unpaid sale", async () => {
    // The payment that clears a sale must land in the sale's own event group:
    // a balance payment from another order credits the same attendee, but the
    // sale it never covered stays incomplete.
    const { attendee, listing } = await setupUnpaidSale(
      "Other Order Paid",
      "other-order-paid@example.com",
    );
    await postPaymentLeg(
      attendeeAccount(attendee.id),
      await balanceEventGroup("overview_other_order_paid"),
      "overview-other-order-payment",
    );

    const stats = await getListingOverviewStats(listing);
    expect(stats).toMatchObject({
      incompleteQuantity: 1,
      incompleteSales: 500,
    });
  });

  test("does not count a refunded balance-paid attendee whose reference was pruned", async () => {
    // A balance-paid booking: a booking-group sale with no booking-group
    // payment, the payment sitting in its own balance event group.
    const { attendee, listing } = await setupUnpaidSale(
      "Refunded Balance",
      "refunded-balance@example.com",
    );
    await postPaymentLeg(
      attendeeAccount(attendee.id),
      await balanceEventGroup("overview_refunded_balance"),
      "overview-refunded-balance-payment",
    );
    // Then it is refunded: a `refund_cash` leg sourced from the attendee. Once
    // that exists prunePayments drops the processed reference, so no surviving
    // reference remains — only the ledger-fed refunded flag keeps this out of
    // the incomplete split.
    await postTransfers([
      {
        amount: 500,
        destination: WORLD,
        eventGroup: await balanceEventGroup("overview_refunded_balance_refund"),
        kind: KIND.refundCash,
        occurredAt: "2026-06-22T00:00:00.000Z",
        reference: "overview-refunded-balance-refund",
        source: attendeeAccount(attendee.id),
      },
    ]);

    const stats = await getListingOverviewStats(listing);
    expect(stats).toMatchObject({
      incompleteQuantity: 0,
      incompleteSales: 0,
    });
  });
});
