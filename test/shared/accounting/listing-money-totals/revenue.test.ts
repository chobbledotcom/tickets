import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { revenueAccount } from "#shared/accounting/accounts.ts";
import { listingMoneyTotals } from "#shared/accounting/listing-money-totals.ts";
import {
  MANUAL_LISTING_COST,
  MANUAL_LISTING_INCOME,
} from "#shared/accounting/manual-entries.ts";
import { accountBalance } from "#shared/accounting/queries.ts";
import { emptyRange } from "#shared/accounting/range.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { account } from "#shared/ledger/account.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  postAttendeeRefund,
  postListingSale,
  postWriteoffAdjustment,
} from "#test-utils/ledger.ts";

describeWithEnv("db > listings", { db: true, triggers: true }, () => {
  describe("listingMoneyTotals for one listing", () => {
    /** Read the listing's income through the public listing projection. */
    const projectedIncome = async (listingId: number): Promise<number> => {
      const listing = await getListingWithCount(listingId);
      if (!listing) throw new Error(`Listing ${listingId} was not found`);
      return listing.income;
    };

    /** Assert a breakdown's recognised income and net balance agree with the
     * production projections they're supposed to mirror — the invariant every
     * scenario in this suite reconciles against. */
    const expectReconciles = async (
      breakdown: Awaited<ReturnType<typeof listingMoneyTotals>>,
      listingId: number,
    ): Promise<void> => {
      expect(breakdown.recognisedIncome).toBe(await projectedIncome(listingId));
      expect(breakdown.netBalance).toBe(
        await accountBalance(revenueAccount(listingId)),
      );
    };

    test("derives gross sales, a manual write-down, and refunds, and reconciles", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      const buyer = await createTestAttendee(
        listing.id,
        listing.slug,
        "Ada",
        "ada@example.com",
      );
      // Two gross sales credit revenue:id.
      await postListingSale({
        attendeeId: buyer.id,
        eventId: "sale-a",
        gross: 5000,
        listingId: listing.id,
      });
      await postListingSale({
        attendeeId: buyer.id,
        eventId: "sale-b",
        gross: 3000,
        listingId: listing.id,
      });
      // A manual write-DOWN (decision 14): revenue:id → writeoff, lowering income.
      await postWriteoffAdjustment(revenueAccount(listing.id), -1000, [
        "income-adjust",
        listing.id,
      ]);
      // A refund debits revenue:id (revenue → attendee) without touching income.
      await postAttendeeRefund({
        attendeeId: buyer.id,
        gross: 2000,
        listingId: listing.id,
      });

      const breakdown = await listingMoneyTotals(emptyRange, [listing.id]);
      // The refund also posts its own net-zero sale leg first, so gross is 10000.
      expect(breakdown.grossSales).toBe(10000);
      expect(breakdown.externalIncome).toBe(0);
      expect(breakdown.manualAdjustments).toBe(-1000);
      expect(breakdown.recognisedIncome).toBe(9000);
      expect(breakdown.refunds).toBe(2000);
      expect(breakdown.externalCosts).toBe(0);
      expect(breakdown.netBalance).toBe(7000);

      // Reconciliation invariants: recognised income equals the existing income
      // projection, and the net balance equals the raw account balance.
      await expectReconciles(breakdown, listing.id);
      // The breakdown reconciles on its own face, too.
      expect(breakdown.recognisedIncome).toBe(
        breakdown.grossSales +
          breakdown.externalIncome +
          breakdown.manualAdjustments,
      );
      expect(breakdown.netBalance).toBe(
        breakdown.recognisedIncome -
          breakdown.refunds -
          breakdown.externalCosts,
      );
    });

    test("counts a manual write-up as a positive adjustment", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      const buyer = await createTestAttendee(
        listing.id,
        listing.slug,
        "Grace",
        "grace@example.com",
      );
      await postListingSale({
        attendeeId: buyer.id,
        gross: 4000,
        listingId: listing.id,
      });
      // A manual write-UP: writeoff → revenue:id, raising income.
      await postWriteoffAdjustment(revenueAccount(listing.id), 1500, [
        "income-adjust",
        listing.id,
      ]);

      const breakdown = await listingMoneyTotals(emptyRange, [listing.id]);
      expect(breakdown.grossSales).toBe(4000);
      expect(breakdown.manualAdjustments).toBe(1500);
      expect(breakdown.recognisedIncome).toBe(5500);
      expect(breakdown.refunds).toBe(0);
      expect(breakdown.netBalance).toBe(5500);
      await expectReconciles(breakdown, listing.id);
    });

    test("includes owner-entered outside income and listing costs in the reconciliation", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      const revenue = revenueAccount(listing.id);
      await postTransfers([
        {
          amount: 600,
          destination: revenue,
          eventGroup: "manual-income",
          kind: MANUAL_LISTING_INCOME,
          occurredAt: "2026-06-21T09:00:00.000Z",
          reference: "manual-income",
          source: account("external", "world"),
        },
      ]);
      await postTransfers([
        {
          amount: 250,
          destination: account("external", "world"),
          eventGroup: "manual-cost",
          kind: MANUAL_LISTING_COST,
          occurredAt: "2026-06-21T10:00:00.000Z",
          reference: "manual-cost",
          source: revenue,
        },
      ]);

      const breakdown = await listingMoneyTotals(emptyRange, [listing.id]);
      expect(breakdown.grossSales).toBe(0);
      expect(breakdown.externalIncome).toBe(600);
      expect(breakdown.manualAdjustments).toBe(0);
      expect(breakdown.recognisedIncome).toBe(600);
      expect(breakdown.refunds).toBe(0);
      expect(breakdown.externalCosts).toBe(250);
      expect(breakdown.netBalance).toBe(350);
      await expectReconciles(breakdown, listing.id);
    });

    test("is all-zero for a listing with no ledger activity", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      const breakdown = await listingMoneyTotals(emptyRange, [listing.id]);
      expect(breakdown).toEqual({
        externalCosts: 0,
        externalIncome: 0,
        grossSales: 0,
        manualAdjustments: 0,
        netBalance: 0,
        recognisedIncome: 0,
        refunds: 0,
        servicingCosts: 0,
        transferCount: 0,
      });
      await expectReconciles(breakdown, listing.id);
    });

    test("an occurred-at range scopes the breakdown to that window", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      const revenue = revenueAccount(listing.id);
      const buyer = account("attendee", 1);
      const sale = (reference: string, gross: number, occurredAt: string) =>
        postTransfers([
          {
            amount: gross,
            destination: revenue,
            eventGroup: reference,
            kind: "sale",
            occurredAt,
            reference,
            source: buyer,
          },
        ]);
      await sale("early-sale", 1000, "2026-06-20T12:00:00.000Z");
      await sale("late-sale", 4000, "2026-06-22T12:00:00.000Z");

      // Unbounded: both sales count.
      expect(
        (await listingMoneyTotals(emptyRange, [listing.id])).grossSales,
      ).toBe(5000);
      // Windowed to [21st, 23rd): only the 22nd sale.
      const windowed = await listingMoneyTotals(
        {
          endMs: new Date("2026-06-23T00:00:00.000Z").getTime(),
          startMs: new Date("2026-06-21T00:00:00.000Z").getTime(),
        },
        [listing.id],
      );
      expect(windowed.grossSales).toBe(4000);
      expect(windowed.recognisedIncome).toBe(4000);
      expect(windowed.transferCount).toBe(1);
    });
  });
});
