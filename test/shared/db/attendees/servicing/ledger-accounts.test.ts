/**
 * Servicing §22 — ledger accounts, profit, and append-only history.
 *
 * A servicing hold is free, so creating one posts no sale/payment/fee legs. An
 * operator can record a cost against it (e.g. £90 for a boiler part): one
 * `cost:L → world` leg, `kind='service_cost'`, dated at the service date.
 * `cost(L) = −balanceOf(cost:L)` is the positive total of cost legs; profit is
 * `income(L) − cost(L)` (gross income preserved). Deleting a servicing event
 * never touches the ledger — cost legs remain as orphaned history.
 *
 * Implementation contract (test-first):
 *   - `#shared/accounting/accounts.ts` exports `COST = "cost"` and
 *     `costAccount = rowAccount(COST)` (reuses the `rowAccount` id guard).
 *   - Listing cost is read from the cost account balance, and listing profit
 *     comes from the same SQL row projection the admin page displays.
 *   - Transfer `kind='service_cost'`; the cost account is `cost:<listingId>`.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { costAccount, revenueAccount } from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import {
  accountBalance,
  allTransfers,
  transfersByAccount,
} from "#shared/accounting/queries.ts";
import { formatCurrency } from "#shared/currency.ts";
import { account } from "#shared/ledger/account.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  createServicingHold,
  deleteServicingEvent,
  expectCostAfterRecording,
  listingCostOf,
  renderAdminPage,
} from "#test-utils/servicing.ts";
import {
  listingProfitOf,
  postCustomerSale,
  recordBoilerCost,
  SERVICE_DATE,
  transfersOfKind,
} from "#test-utils/servicing-ledger.ts";

// jscpd:ignore-end

describe("servicing §22 — costAccount id validation (reuses rowAccount)", () => {
  test("costAccount rejects 0/negative/fractional ids (no phantom cost account)", () => {
    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => costAccount(bad)).toThrow();
    }
  });

  test("costAccount mints a cost:<id> account for a positive integer id", () => {
    expect(costAccount(5)).toEqual(account("cost", 5));
  });
});

describeWithEnv(
  "servicing §22 — ledger accounts & profit",
  { db: true },
  () => {
    test("creating a servicing event posts no sale, payment, or fee legs (never a sale)", async () => {
      const { listing } = await createServicingHold();
      const kinds = (await allTransfers()).map((t) => t.kind);
      expect(kinds).not.toContain("sale");
      expect(kinds).not.toContain("payment");
      expect(kinds).not.toContain("fee");
      expect(await accountBalance(revenueAccount(listing.id))).toBe(0);
    });

    test("recording a cost posts one cost:L → world leg, kind='service_cost', dated at the service date", async () => {
      const { id, listing } = await createServicingHold();
      await recordBoilerCost(id, listing.id);
      const costLegs = await transfersOfKind(KIND.serviceCost);
      expect(costLegs.length).toBe(1);
      const leg = costLegs[0]!;
      expect(leg.source).toEqual(account("cost", listing.id));
      expect(leg.destination).toEqual(account("external", "world"));
      expect(leg.amount).toBe(9000);
      expect(leg.occurredAt).toBe(SERVICE_DATE);
    });

    test("cost(L) sums cost legs and is zero when there are none", async () => {
      const { id, listing } = await createServicingHold();
      expect(await listingCostOf(listing.id)).toBe(0);
      await expectCostAfterRecording(id, listing.id, 9000, 9000);
    });

    test("profit(L) = income(L) − cost(L) (gross income preserved)", async () => {
      const { listing } = await createServicingHold();
      // £200 income from a real customer booking.
      await postCustomerSale(listing.id);
      // £90 cost from the service event.
      const { id } = await createServicingHold({ listing: { name: "L" } });
      await expectCostAfterRecording(id, listing.id, 9000, 9000);
      expect(await accountBalance(revenueAccount(listing.id))).toBe(20000);
      expect(await listingProfitOf(listing.id)).toBe(11000);
    });

    test("listing row profit stays gross after a refund", async () => {
      // The listing row projects profit as recognised (gross) income − costs
      // (listingProfitSubquery). An older reader used the NET revenue balance
      // (`accountBalance(revenue) − cost`), so after a refund — which lowers the
      // net balance but not recognised income — it diverged from the listing row.
      const { postAttendeeRefund } = await import("#test-utils/ledger.ts");
      const listing = await createTestListing({ maxAttendees: 10, name: "L" });
      const { attendee } = await createTestAttendeeDirect(
        listing.id,
        "Customer",
        "c@example.com",
      );
      // A £200 sale, fully refunded: gross income 200 (sale credit), net 0.
      await postAttendeeRefund({
        attendeeId: attendee.id,
        gross: 20000,
        listingId: listing.id,
      });
      // A £90 servicing cost on the same listing.
      const { id } = await createServicingHold({ listing: { name: "L" } });
      await recordBoilerCost(id, listing.id);

      const {
        getListingWithCount,
        invalidateListingsCache,
        listingRevenueBreakdown,
      } = await import("#shared/db/listings.ts");
      invalidateListingsCache();
      const row = await getListingWithCount(listing.id);
      const breakdown = await listingRevenueBreakdown(listing.id);

      // Recognised income is gross (£200) — the refund drops the net balance to 0
      // but does NOT lower recognised income or the listing's profit.
      expect(breakdown.recognisedIncome).toBe(20000);
      expect(breakdown.netBalance).toBe(0);
      expect(await listingCostOf(listing.id)).toBe(9000);
      expect(await listingProfitOf(listing.id)).toBe(11000); // 200 − 90
      expect(row?.profit).toBe(11000); // SQL listingProfitSubquery (the listing row)
    });

    test("listing detail surfaces service costs and profit", async () => {
      const { listing } = await createServicingHold();
      await postCustomerSale(listing.id);
      const { id } = await createServicingHold({ listing: { name: "L" } });
      await recordBoilerCost(id, listing.id);

      const html = await renderAdminPage(`/admin/listing/${listing.id}`);

      expect(html).toContain("Servicing costs");
      expect(html).toContain(formatCurrency(9000));
      expect(html).toContain("Profit before refunds");
      expect(html).toContain(formatCurrency(11000));
    });

    test("deleting a servicing event leaves its cost legs as append-only history", async () => {
      // The transfers ledger is append-only — deleting a servicing event does
      // NOT reverse or remove its cost legs. They remain as history, the same
      // way sale legs for a deleted listing remain. The ledger UI shows
      // "Deleted listing" for the unresolved account label.
      const { id, listing } = await createServicingHold();
      await recordBoilerCost(id, listing.id);
      expect(await listingCostOf(listing.id)).toBe(9000);
      await deleteServicingEvent(id);
      // The cost legs are untouched — the original leg still exists.
      const legs = await transfersByAccount(costAccount(listing.id));
      expect(legs.length).toBe(1);
      expect(legs[0]!.amount).toBe(9000);
    });
  },
);
