import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeeAccount, revenueAccount } from "#accounting/accounts.ts";
import { accountBalance, allTransfers } from "#accounting/queries.ts";
import type { TicketListing } from "#booking/model.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { modifiersTable } from "#db/modifiers.ts";
import { createFreeReservation } from "#routes/public/free-reservation.ts";
import { parseQuantityValue } from "#routes/public/ticket-form.ts";
import type { PricedLine, PricedOrder } from "#shared/checkout-pricing.ts";
import type { CheckoutItem } from "#shared/payments.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { expectNoAttendeesForListings } from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { runAndCountRoundTrips } from "#test-utils/query-log.ts";
import { says } from "#test-utils/says.ts";
import type { ContactInfo } from "#types";
import { ticketListingFor } from "./ticket-payment/helpers.ts";

/** Build per-path checkout items from positive quantities. A
 * `packageGroupId` stamps every line as booked through that package. */
const itemsFor = (
  listings: TicketListing[],
  quantities: Map<number, number>,
  packageGroupId?: number,
): CheckoutItem[] =>
  listings
    .filter((info) => (quantities.get(info.listing.id) ?? 0) > 0)
    .map((info) => ({
      listingId: info.listing.id,
      name: info.listing.name,
      ...(packageGroupId === undefined ? {} : { packageGroupId }),
      quantity: quantities.get(info.listing.id)!,
      slug: info.listing.slug,
      unitPrice: info.listing.unit_price,
    }));

const contact: ContactInfo = {
  address: "",
  email: "buyer@example.com",
  name: "Buyer",
  phone: "",
  special_instructions: "",
};

describeWithEnv("routes > public > ticket-payment", { db: true }, () => {
  describe("parseQuantityValue", () => {
    test("defaults malformed input and honours the field minimum", () => {
      expect(parseQuantityValue(" 2 ", 0)).toBe(2);
      expect(parseQuantityValue("0", 0)).toBe(0);
      expect(parseQuantityValue("2x", 0)).toBe(0);
    });

    test("uses the minimum default when zero is below the field minimum", () => {
      expect(parseQuantityValue("0", 5)).toBe(5);
    });
  });

  describe("createFreeReservation (all-or-nothing)", () => {
    test("rejects the whole cart and persists nothing when a group cap is partially exceeded", async () => {
      const group = await createTestGroup({
        maxAttendees: 3,
        name: "free-rollback",
        slug: "free-rollback",
      });
      const e1 = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 10,
        name: "free-a",
      });
      const e2 = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 10,
        name: "free-b",
      });
      const ticketListings = [
        await ticketListingFor(e1.id),
        await ticketListingFor(e2.id),
      ];
      const quantities = new Map([
        [e1.id, 2],
        [e2.id, 2],
      ]);
      const result = await createFreeReservation({
        contact,
        date: null,
        items: itemsFor(ticketListings, quantities),
        ledgerOrder: null,
        listings: ticketListings,
        modifierUsages: [],
      });
      expect(result.success).toBe(false);
      await expectNoAttendeesForListings([e1.id, e2.id]);
    });

    test("books the whole cart when the combined order fits the group cap", async () => {
      const group = await createTestGroup({
        maxAttendees: 3,
        name: "free-ok",
        slug: "free-ok",
      });
      const e1 = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 10,
        name: "free-ok-a",
      });
      const e2 = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 10,
        name: "free-ok-b",
      });
      const ticketListings = [
        await ticketListingFor(e1.id),
        await ticketListingFor(e2.id),
      ];
      const result = await createFreeReservation({
        contact,
        date: null,
        items: itemsFor(
          ticketListings,
          new Map([
            [e1.id, 1],
            [e2.id, 2],
          ]),
        ),
        ledgerOrder: null,
        listings: ticketListings,
        modifierUsages: [],
      });
      expect(result.success).toBe(true);
      expect((await getAttendeesRaw(e1.id))[0]!.quantity).toBe(1);
      expect((await getAttendeesRaw(e2.id))[0]!.quantity).toBe(2);
    });

    test("a package capacity error uses its buyer-safe name", async () => {
      // The prepared package line supplies its buyer-safe name to a later capacity error.
      const group = await createTestGroup({
        isPackage: true,
        name: "Sellout Kit",
        slug: "sellout-kit",
      });
      const member = await createTestListing({
        groupId: group.id,
        maxAttendees: 1,
        name: "Secret Widget",
      });
      // Fill the member's only spot so the package reservation can't be created.
      const first = await attendeesApi.createAttendeeAtomic({
        bookings: [{ listingId: member.id, quantity: 1 }],
        email: "first@test.com",
        name: "First",
      });
      if (!first.success) throw new Error("setup booking failed");

      const memberListings = [await ticketListingFor(member.id)];
      const items = itemsFor(
        memberListings,
        new Map([[member.id, 1]]),
        group.id,
      ).map((item) => ({ ...item, name: group.name }));
      const result = await createFreeReservation({
        contact,
        date: null,
        items,
        ledgerOrder: null,
        listings: memberListings,
        modifierUsages: [],
      });
      if (result.success) throw new Error("expected a capacity failure");
      says(result.error, "Sellout Kit");
      assert(!result.error.includes("Secret Widget"));
    });
  });

  describe("concurrent parent/child reservations (capacity races)", () => {
    // A folded parent/child cart reaches the reservation layer as a multi-line
    // order (the parent line plus its chosen children). These prove the
    // all-or-nothing atomic reservation holds when two such carts collide on a
    // shared bottleneck — the loser must roll back fully, never leaving a parent
    // booked without the child it required.
    const freeCart = async (
      parentId: number,
      childId: number,
      email: string,
    ): Promise<{ success: boolean }> => {
      const listings = await Promise.all([
        ticketListingFor(parentId),
        ticketListingFor(childId),
      ]);
      return createFreeReservation({
        contact: { ...contact, email },
        date: null,
        items: itemsFor(
          listings,
          new Map([
            [parentId, 1],
            [childId, 1],
          ]),
        ),
        ledgerOrder: null,
        listings,
        modifierUsages: [],
      });
    };

    test("two carts racing for the last shared-child spot: only one wins, the loser's parent rolls back", async () => {
      // parentA and parentB both fold the SAME child, which has a single spot.
      const parentA = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 10,
        name: "race-parent-a",
      });
      const parentB = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 10,
        name: "race-parent-b",
      });
      const child = await createTestListing({
        maxAttendees: 1,
        maxQuantity: 1,
        name: "race-shared-child",
      });

      const [a, b] = await Promise.all([
        freeCart(parentA.id, child.id, "racea@example.com"),
        freeCart(parentB.id, child.id, "raceb@example.com"),
      ]);

      // Exactly one reservation wins the single child spot.
      expect([a.success, b.success].filter(Boolean).length).toBe(1);
      expect((await getAttendeesRaw(child.id)).length).toBe(1);
      // The winner's parent is booked; the loser's parent is fully rolled back,
      // so no parent is left holding a booking without its required child.
      const winner = a.success ? parentA.id : parentB.id;
      const loser = a.success ? parentB.id : parentA.id;
      expect((await getAttendeesRaw(winner)).length).toBe(1);
      expect((await getAttendeesRaw(loser)).length).toBe(0);
    });

    test("parent+child sharing a capped group consume two group spots; a concurrent second order is refused", async () => {
      // Parent and child share a group with only two spots, so one parent+child
      // order (one spot each, PARENT_CHILD_GROUP_UNITS) fills the group exactly.
      const group = await createTestGroup({
        maxAttendees: 2,
        name: "pc-group",
        slug: "pc-group",
      });
      const parent = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 10,
        name: "pc-parent",
      });
      const child = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 10,
        name: "pc-child",
      });

      const [a, b] = await Promise.all([
        freeCart(parent.id, child.id, "group1@example.com"),
        freeCart(parent.id, child.id, "group2@example.com"),
      ]);

      // The group holds two spots; one parent+child order fills both, so exactly
      // one order wins and the other is refused in full.
      expect([a.success, b.success].filter(Boolean).length).toBe(1);
      expect((await getAttendeesRaw(parent.id)).length).toBe(1);
      expect((await getAttendeesRaw(child.id)).length).toBe(1);
    });
  });

  describe("createFreeReservation (ledger)", () => {
    /** A zero-total priced order for one listing: full list price as gross, but
     *  nothing charged now (a fully-discounted booking or a zero-deposit hold). */
    const zeroTotalOrder = (listingId: number, gross: number): PricedOrder => {
      const line: PricedLine = {
        chargedUnitAmount: 0,
        item: {
          listingId,
          name: `L${listingId}`,
          quantity: 1,
          slug: `l${listingId}`,
          unitPrice: gross,
        },
        quantity: 1,
      };
      return {
        extras: [],
        fullSubtotal: gross,
        lines: [line],
        modifierApplications: [],
        total: 0,
      };
    };

    /** A fresh five-spot listing with the one-unit reservation input every
     * ledger test here builds on (ledgerOrder/modifierUsages vary per test). */
    const oneLineBooking = async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const ticketListings = [await ticketListingFor(listing.id)];
      return {
        base: {
          contact,
          date: null,
          items: itemsFor(ticketListings, new Map([[listing.id, 1]])),
          listings: ticketListings,
        },
        listing,
      };
    };

    test("records the gross sale and the balance owed for a payments-enabled zero-total reservation", async () => {
      const { base, listing } = await oneLineBooking();
      const result = await createFreeReservation({
        ...base,
        ledgerOrder: zeroTotalOrder(listing.id, 5000),
        modifierUsages: [],
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      const attendeeId = result.entries[0]!.attendee.id;
      // The zero-deposit reservation now posts the gross sale and the balance the
      // attendee still owes, so a later balance payment settles against the
      // ledger instead of finding no booking legs at all.
      expect(await accountBalance(revenueAccount(listing.id))).toBe(5000);
      expect(await accountBalance(attendeeAccount(attendeeId))).toBe(-5000);
    });

    test("commits a large free multi-listing order in a bounded number of round-trips", async () => {
      // Regression: a free/owed multi-listing cart posts one sale leg per listing.
      // Posting them inside an interactive transaction (a read-then-write per leg)
      // held the write lock open and could blow the primary's transaction timeout.
      // The whole reservation must be one batch — O(1) round-trips, not O(listings).
      const N = 15;
      // Sequential: each createTestListing runs an authenticated request that
      // mints a session, so building them concurrently would collide session
      // tokens — the round-trip count we assert on is the order, not the setup.
      const listings: Awaited<ReturnType<typeof createTestListing>>[] = [];
      for (let i = 0; i < N; i++) {
        listings.push(await createTestListing({ maxAttendees: 5 }));
      }
      const ledgerOrder: PricedOrder = {
        extras: [],
        fullSubtotal: N * 1000,
        lines: listings.map((l) => ({
          chargedUnitAmount: 0,
          item: {
            listingId: l.id,
            name: `L${l.id}`,
            quantity: 1,
            slug: `l${l.id}`,
            unitPrice: 1000,
          },
          quantity: 1,
        })),
        modifierApplications: [],
        total: 0,
      };

      const { value: result, roundTrips } = await runAndCountRoundTrips(
        async () => {
          const ticketListings = await Promise.all(
            listings.map((l) => ticketListingFor(l.id)),
          );
          return createFreeReservation({
            contact,
            date: null,
            items: itemsFor(
              ticketListings,
              new Map(listings.map((l) => [l.id, 1])),
            ),
            ledgerOrder,
            listings: ticketListings,
            modifierUsages: [],
          });
        },
      );

      expect(result.success).toBe(true);
      // The N sale legs ride one batch, so the reservation's round-trips don't
      // scale with N (an interactive per-leg post would be ~2N and trip the guard).
      expect(roundTrips).toBeLessThanOrEqual(8);
    });

    test("rolls back and reports the add-on as sold out when its stock is gone", async () => {
      const m = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "Add-on",
        stock: 0,
      });

      const { base, listing } = await oneLineBooking();
      const result = await createFreeReservation({
        ...base,
        // No provider configured, but the booking still carries a stock-limited
        // add-on: the create runs in a transaction to consume stock and rolls the
        // whole thing back when that add-on is gone, even with no ledger to post.
        ledgerOrder: null,
        modifierUsages: [{ amountApplied: 500, modifierId: m.id, quantity: 1 }],
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBe(
        "An extra you selected sold out while you were checking out. Please try again.",
      );
      // Nothing persisted — no attendee, and no orphaned ledger legs.
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
      expect((await allTransfers()).length).toBe(0);
    });
  });
});
