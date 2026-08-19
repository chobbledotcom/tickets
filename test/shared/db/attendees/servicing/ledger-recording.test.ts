// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { revenueAccount } from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import { listingMoneyTotals } from "#accounting/listing-money-totals.ts";
import {
  accountBalance,
  allTransfers,
  visibleTransfers,
} from "#accounting/queries.ts";
import { emptyRange } from "#accounting/range.ts";
import { formatCurrency } from "#shared/currency.ts";
import { account } from "#shared/ledger/account.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  adminPost,
  createDatedServicingScenario,
  createServicingHold,
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

describeWithEnv(
  "servicing §22 - cost recording and listing profit",
  { db: true },
  () => {
    test("creating a servicing event posts no sale, payment, or fee legs (never a sale)", async () => {
      const { listing } = await createServicingHold();
      const kinds = (await allTransfers()).map((transfer) => transfer.kind);
      expect(kinds).not.toContain("sale");
      expect(kinds).not.toContain("payment");
      expect(kinds).not.toContain("fee");
      expect(await accountBalance(revenueAccount(listing.id))).toBe(0);
    });

    test("recording a cost posts one cost:L -> world leg, kind='service_cost', dated at the service date", async () => {
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

    test("profit(L) = income(L) - cost(L) (gross income preserved)", async () => {
      const { listing } = await createServicingHold();
      await postCustomerSale(listing.id);
      const { id } = await createServicingHold({ listing: { name: "L" } });
      await expectCostAfterRecording(id, listing.id, 9000, 9000);
      expect(await accountBalance(revenueAccount(listing.id))).toBe(20000);
      expect(await listingProfitOf(listing.id)).toBe(11000);
    });

    test("listing row profit stays gross after a refund", async () => {
      const { postAttendeeRefund } = await import("#test-utils/ledger.ts");
      const listing = await createTestListing({ maxAttendees: 10, name: "L" });
      const { attendee } = await createTestAttendeeDirect(
        listing.id,
        "Customer",
        "c@example.com",
      );
      await postAttendeeRefund({
        attendeeId: attendee.id,
        gross: 20000,
        listingId: listing.id,
      });
      const { id } = await createServicingHold({ listing: { name: "L" } });
      await recordBoilerCost(id, listing.id);

      const { getListingWithCount, invalidateListingsCache } = await import(
        "#db/listings/records.ts"
      );
      invalidateListingsCache();
      const row = await getListingWithCount(listing.id);
      const breakdown = await listingMoneyTotals(emptyRange, [listing.id]);

      expect(breakdown.recognisedIncome).toBe(20000);
      expect(breakdown.netBalance).toBe(0);
      expect(await listingCostOf(listing.id)).toBe(9000);
      expect(await listingProfitOf(listing.id)).toBe(11000);
      expect(row?.profit).toBe(11000);
    });

    test("listing detail surfaces service costs and profit", async () => {
      const { listing } = await createServicingHold();
      await postCustomerSale(listing.id);
      const { id } = await createServicingHold({ listing: { name: "L" } });
      await recordBoilerCost(id, listing.id);

      const html = await renderAdminPage(`/admin/listing/${listing.id}`);

      expect(html).toContain("Service event costs");
      expect(html).toContain(formatCurrency(9000));
      expect(html).toContain("Profit before refunds");
      expect(html).toContain(formatCurrency(11000));
    });

    test("the cost route dates the cost leg to the service event date, not the submit time", async () => {
      const { id, listing } = await createDatedServicingScenario();
      await adminPost(`/admin/servicing/${id}`, {
        amount: "90.00",
        memo: "Boiler part",
        target_listing_id: String(listing.id),
      });
      const legs = await transfersOfKind(KIND.serviceCost);
      expect(legs.length).toBe(1);
      expect(legs[0]!.occurredAt).toBe(SERVICE_DATE);
    });

    test("service_cost legs appear in the listing-filtered visible ledger", async () => {
      const { id, listing } = await createServicingHold();
      await recordBoilerCost(id, listing.id);
      await createTestListing({ maxAttendees: 10, name: "Other listing" });
      const other = await createServicingHold({
        listing: { name: "Other listing" },
        name: "Other service",
      });
      await recordBoilerCost(other.id, other.listing.id);

      const legs = await visibleTransfers(emptyRange, [listing.id], 100);
      expect(legs).toHaveLength(1);
      expect(legs[0]?.kind).toBe(KIND.serviceCost);
      expect(legs[0]?.source).toEqual(account("cost", listing.id));
    });
  },
);
