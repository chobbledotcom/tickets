import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { parseQuantityValue } from "#routes/public/ticket-form.ts";
import {
  createFreeReservation,
  dailyDateItems,
  foldSelectedChildren,
  loadChildrenByParentId,
  MODIFIER_SOLD_OUT_MESSAGE,
  resolveDayCount,
} from "#routes/public/ticket-payment.ts";
import {
  attendeeAccount,
  revenueAccount,
} from "#shared/accounting/accounts.ts";
import { accountBalance, allTransfers } from "#shared/accounting/queries.ts";
import {
  buildTicketListing,
  type TicketListing,
} from "#shared/booking/model.ts";
import type { PricedLine, PricedOrder } from "#shared/checkout-pricing.ts";
import { addDays } from "#shared/dates.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { FormParams } from "#shared/form-data.ts";
import type { CheckoutItem } from "#shared/payments.ts";
import { todayInTz } from "#shared/timezone.ts";
import type { ContactInfo, ListingWithCount } from "#shared/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { expectNoAttendeesForListings } from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { makeParent } from "#test-utils/parents.ts";
import { runAndCountRoundTrips } from "#test-utils/query-log.ts";

/** Wrap a listing-with-count as a selected cart line. */
const line = (listing: ListingWithCount, qty = 1) => ({ listing, qty });

/** Build the per-path checkout items an old quantities map described: one line
 * per listing with a positive quantity, priced at the listing's own unit price.
 * A `packageGroupId` stamps every line as booked through that package. */
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

const allDays = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

const contact: ContactInfo = {
  address: "",
  email: "buyer@example.com",
  name: "Buyer",
  phone: "",
  special_instructions: "",
};

/** Fetch an listing with its live attendee count and wrap it as a TicketListing. */
const ticketListingFor = async (listingId: number): Promise<TicketListing> => {
  const listing = (await getListingWithCount(listingId)) as ListingWithCount;
  return buildTicketListing(listing, false, undefined);
};

describeWithEnv("routes > public > ticket-payment", { db: true }, () => {
  describe("parseQuantityValue", () => {
    test("caps valid quantities and defaults malformed input", () => {
      expect(parseQuantityValue(" 2 ", 5, 0)).toBe(2);
      expect(parseQuantityValue("0", 5, 0)).toBe(0);
      expect(parseQuantityValue("7", 5, 0)).toBe(5);
      expect(parseQuantityValue("2x", 5, 0)).toBe(0);
    });

    test("uses the minimum default when zero is below the field minimum", () => {
      expect(parseQuantityValue("0", 5)).toBe(1);
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

    test("a package order's capacity error omits the member name", async () => {
      // A hidden package conceals its members, so a sellout between render and
      // insert must not surface a member's name in the capacity error. The
      // omission applies to every package order (packageGroupId set); the hidden
      // package is the privacy-critical case.
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
      const result = await createFreeReservation({
        contact,
        date: null,
        // The member's item carries the package id — the per-line stamp every
        // package path now rides on.
        items: itemsFor(memberListings, new Map([[member.id, 1]]), group.id),
        ledgerOrder: null,
        listings: memberListings,
        modifierUsages: [],
      });
      if (result.success) throw new Error("expected a capacity failure");
      // Generic message — never the concealed member's name.
      expect(result.error).toContain("not enough spots available");
      expect(result.error).not.toContain("Secret Widget");
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
      expect(result.error).toBe(MODIFIER_SOLD_OUT_MESSAGE);
      // Nothing persisted — no attendee, and no orphaned ledger legs.
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
      expect((await allTransfers()).length).toBe(0);
    });
  });

  describe("resolveDayCount", () => {
    const custStandard = (overrides = {}) =>
      testListingWithCount({
        customisable_days: true,
        day_prices: { 1: 1000, 2: 1800 },
        duration_days: 2,
        listing_type: "standard",
        ...overrides,
      });

    test("returns a single day when no selected listing is customisable", async () => {
      const result = await resolveDayCount(
        [line(testListingWithCount({ id: 1 }))],
        new FormParams({}),
        null,
      );
      expect(result).toEqual({ dayCount: 1 });
    });

    test("rejects a missing day count", async () => {
      const result = await resolveDayCount(
        [line(custStandard({ id: 1 }))],
        new FormParams({}),
        null,
      );
      expect(result).toEqual({ error: "Please choose how many days to book" });
    });

    test("rejects malformed day counts instead of parsing their prefix", async () => {
      const result = await resolveDayCount(
        [line(custStandard({ id: 1 }))],
        new FormParams({ day_count: "2x" }),
        null,
      );
      expect(result).toEqual({
        error: "Please choose how many days to book",
      });
    });

    test("rejects a day count with no configured price", async () => {
      const result = await resolveDayCount(
        [line(custStandard({ id: 1, name: "Pass" }))],
        new FormParams({ day_count: "5" }),
        null,
      );
      expect(result).toEqual({
        error: "Pass does not offer a 5-day booking",
      });
    });

    test("accepts a valid day count for a standard customisable listing", async () => {
      const result = await resolveDayCount(
        [line(custStandard({ id: 1 }))],
        new FormParams({ day_count: "2" }),
        null,
      );
      expect(result).toEqual({ dayCount: 2 });
    });

    test("rejects a daily range that runs past the booking window", async () => {
      const listing = testListingWithCount({
        bookable_days: allDays,
        customisable_days: true,
        day_prices: { 1: 1000, 5: 4000 },
        duration_days: 5,
        listing_type: "daily",
        maximum_days_after: 2,
        minimum_days_before: 0,
        name: "Trip",
      });
      const result = await resolveDayCount(
        [line(listing)],
        new FormParams({ day_count: "5" }),
        todayInTz("UTC"),
      );
      expect(result).toEqual({
        error:
          "Trip: 5 days aren't all available from that date — choose fewer days or a different start date",
      });
    });

    test("accepts a daily range that fits the window", async () => {
      const listing = testListingWithCount({
        bookable_days: allDays,
        customisable_days: true,
        day_prices: { 1: 1000, 3: 2500 },
        duration_days: 3,
        listing_type: "daily",
        maximum_days_after: 10,
        minimum_days_before: 0,
      });
      const result = await resolveDayCount(
        [line(listing)],
        new FormParams({ day_count: "3" }),
        todayInTz("UTC"),
      );
      expect(result).toEqual({ dayCount: 3 });
    });
  });

  describe("dailyDateItems", () => {
    test("offers individually-bookable starts for customisable daily listings", async () => {
      // duration_days is the max (5); a non-customisable listing would only
      // offer starts whose 5-day span fits, but a customisable one offers
      // every single-day start within the window.
      const listing = testListingWithCount({
        bookable_days: allDays,
        customisable_days: true,
        day_prices: { 1: 1000, 5: 4000 },
        duration_days: 5,
        listing_type: "daily",
        maximum_days_after: 3,
        minimum_days_before: 0,
        name: "Windowed",
      });
      const items = await dailyDateItems([
        buildTicketListing(listing, false, undefined),
      ]);
      expect(items).toHaveLength(1);
      // The last day in the 3-day window can't fit a 5-day span, yet it's still
      // offered as a start because availability is computed for a single day.
      expect(items[0]).toMatchObject({
        dates: expect.arrayContaining([addDays(todayInTz("UTC"), 3)]),
        id: listing.id,
        name: "Windowed",
      });
    });

    test("skips non-daily listings entirely", async () => {
      const listing = testListingWithCount({ listing_type: "standard" });
      expect(
        await dailyDateItems([buildTicketListing(listing, false, undefined)]),
      ).toEqual([]);
    });
  });

  describe("foldSelectedChildren — allocations", () => {
    /** Minimal TicketCtx stub for foldSelectedChildren tests. */
    const stubCtx = (
      listings: TicketListing[],
      childrenByParentId: import("#routes/public/types.ts").ChildrenByParentId,
    ): import("#routes/public/types.ts").TicketCtx => ({
      addOns: [],
      cartDateItems: [],
      childDatesById: new Map(),
      childrenByParentId,
      dates: [],
      galleryImages: [],
      galleryTarget: null,
      listings,
      packageGroupRemainingByGroupId: new Map(),
      packageMemberGroupIds: new Map(),
      packages: [],
      questionListingMap: new Map(),
      questions: [],
      slugs: [],
      terms: "",
    });

    const doFold = (
      ctx: import("#routes/public/types.ts").TicketCtx,
      form: FormParams,
      quantities: Map<number, number>,
    ) =>
      foldSelectedChildren(ctx, form, {
        customPrices: new Map(),
        date: null,
        dayCount: 1,
        hasCustomisable: false,
        quantities,
      });

    test("single parent with one child records one allocation entry", async () => {
      const { parent, child } = await makeParent({
        children: [{ maxAttendees: 10, maxQuantity: 10 }],
        parent: { maxAttendees: 10, maxQuantity: 10 },
      });
      const parentListing = await ticketListingFor(parent.id);
      await ticketListingFor(child.id);
      const childrenByParentId = await loadChildrenByParentId([parentListing]);
      const ctx = stubCtx([parentListing], childrenByParentId);
      const form = new FormParams({
        [`child_qty_${parent.id}_${child.id}`]: "1",
      });
      const fold = await doFold(ctx, form, new Map([[parent.id, 1]]));
      expect(fold.ok).toBe(true);
      if (!fold.ok) return;
      expect(fold.allocations).toHaveLength(1);
      expect(fold.allocations[0]).toEqual({
        childId: child.id,
        parentId: parent.id,
        qty: 1,
      });
    });

    test("same child under two parents produces two allocation entries", async () => {
      // Two parents each requiring the same child (qty 1 each).
      // The fold sums the child to qty 2 but records two distinct allocations.
      const child = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 10,
        name: "shared-child",
      });
      // Both parents are wired directly to the shared child.
      const { listingChildren } = await import("#shared/db/listing-parents.ts");
      const parentA = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 10,
        name: "parentA",
      });
      await listingChildren.setIds(parentA.id, [child.id]);
      const parentB = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 10,
        name: "parentB",
      });
      await listingChildren.setIds(parentB.id, [child.id]);

      const parentAListing = await ticketListingFor(parentA.id);
      const parentBListing = await ticketListingFor(parentB.id);
      const childrenByParentId = await loadChildrenByParentId([
        parentAListing,
        parentBListing,
      ]);
      const ctx = stubCtx([parentAListing, parentBListing], childrenByParentId);
      const form = new FormParams({
        [`child_qty_${parentA.id}_${child.id}`]: "1",
        [`child_qty_${parentB.id}_${child.id}`]: "1",
      });
      const fold = await doFold(
        ctx,
        form,
        new Map([
          [parentA.id, 1],
          [parentB.id, 1],
        ]),
      );
      expect(fold.ok).toBe(true);
      if (!fold.ok) return;
      // Two allocations: one per (child, parent) pair.
      expect(fold.allocations).toHaveLength(2);
      const parentIds = fold.allocations.map((a) => a.parentId);
      expect(parentIds).toContain(parentA.id);
      expect(parentIds).toContain(parentB.id);
      // Every allocation is for the shared child with qty 1.
      expect(fold.allocations.every((a) => a.childId === child.id)).toBe(true);
      expect(fold.allocations.every((a) => a.qty === 1)).toBe(true);
    });
  });
});
