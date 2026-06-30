import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import fc from "fast-check";
import { parseQuantityValue } from "#routes/public/ticket-form.ts";
import {
  applyPackageOverrides,
  bookingDateFields,
  buildRegistrationItems,
  computeSharedDates,
  createFreeReservation,
  foldChild,
  foldSelectedChildren,
  getTicketContext,
  hidePackageMemberNames,
  loadChildrenByParentId,
  loadPackageMemberMaps,
  MODIFIER_SOLD_OUT_MESSAGE,
  resolveChildSelections,
  resolveDayCount,
} from "#routes/public/ticket-payment.ts";
import {
  attendeeAccount,
  revenueAccount,
} from "#shared/accounting/accounts.ts";
import { accountBalance, allTransfers } from "#shared/accounting/queries.ts";
import type { PricedLine, PricedOrder } from "#shared/checkout-pricing.ts";
import { addDays } from "#shared/dates.ts";
import {
  createAttendeeAtomic,
  ensureAllBookings,
  getAttendeesRaw,
  reverseOrderActivity,
} from "#shared/db/attendees.ts";
import { getDb } from "#shared/db/client.ts";
import {
  getContactRecord,
  getVisits,
  hashEmail,
} from "#shared/db/contact-preferences.ts";
import { setGroupPackageMembers, setListingGroups } from "#shared/db/groups.ts";
import { getListingWithCount } from "#shared/db/listings.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#shared/db/query-log.ts";
import { FormParams } from "#shared/form-data.ts";
import { todayInTz } from "#shared/timezone.ts";
import type { ContactInfo, ListingWithCount } from "#shared/types.ts";
import { buildTicketListing, type TicketListing } from "#templates/public.tsx";
import {
  createTestGroup,
  createTestListing,
  describeWithEnv,
  testListingWithCount,
} from "#test-utils";
import { makeParent } from "#test-utils/parents.ts";

/** Wrap a listing-with-count as a selected cart line. */
const line = (listing: ListingWithCount, qty = 1) => ({ listing, qty });

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

  describe("ensureAllBookings", () => {
    test("ok when every booking in the cart succeeded", async () => {
      const e1 = await createTestListing({ maxAttendees: 10, name: "ok-a" });
      const e2 = await createTestListing({ maxAttendees: 10, name: "ok-b" });
      const result = await createAttendeeAtomic({
        bookings: [
          { listingId: e1.id, quantity: 1 },
          { listingId: e2.id, quantity: 1 },
        ],
        email: contact.email,
        name: contact.name,
      });
      const check = await ensureAllBookings(result, 2, "public");
      expect(check.ok).toBe(true);
      expect((await getAttendeesRaw(e1.id)).length).toBe(1);
      expect((await getAttendeesRaw(e2.id)).length).toBe(1);
      // A kept order leaves the recorded public booking in place.
      const { getTestPrivateKey } = await import("#test-utils");
      const record = await getContactRecord(
        await hashEmail(contact.email),
        await getTestPrivateKey(),
      );
      expect(record.publicBookingCount).toBe(1);
    });

    test("rolls back a partially-fulfilled cart and reports capacity_exceeded", async () => {
      // Group cap 3 forces the second line to fail; createAttendeeAtomic books
      // the first greedily, leaving a partial attendee. ensureAllBookings must
      // delete it so the customer is never left with half a cart.
      const group = await createTestGroup({
        maxAttendees: 3,
        name: "rollback",
        slug: "rollback",
      });
      const e1 = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: "rollback-a",
      });
      const e2 = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: "rollback-b",
      });
      const result = await createAttendeeAtomic({
        bookings: [
          { listingId: e1.id, quantity: 2 },
          { listingId: e2.id, quantity: 2 },
        ],
        email: contact.email,
        name: contact.name,
      });
      // Sanity: the atomic layer fulfilled only the first line.
      expect(result.success).toBe(true);
      if (result.success) expect(result.attendees.length).toBe(1);

      const check = await ensureAllBookings(result, 2, "public");
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.reason).toBe("capacity_exceeded");
      // Full rollback: even the first line's row is gone.
      expect((await getAttendeesRaw(e1.id)).length).toBe(0);
      expect((await getAttendeesRaw(e2.id)).length).toBe(0);
      // ...and the visit + booking the greedy create recorded are undone, so a
      // rolled-back order leaves no phantom history on the contact.
      const emailHash = await hashEmail(contact.email);
      expect(await getVisits(emailHash)).toBe(0);
      const { getTestPrivateKey } = await import("#test-utils");
      const record = await getContactRecord(
        emailHash,
        await getTestPrivateKey(),
      );
      expect(record.publicBookingCount).toBe(0);
    });

    test("propagates the failure reason when the whole cart failed", async () => {
      const failure = {
        reason: "encryption_error" as const,
        success: false as const,
      };
      const check = await ensureAllBookings(failure, 1, "public");
      expect(check).toEqual({ ok: false, reason: "encryption_error" });
    });

    test("reverseOrderActivity is a no-op for a contact with no email or phone", async () => {
      // An order with neither identity yields no contact hashes, so the
      // compensation loop never runs and nothing is written or thrown.
      await reverseOrderActivity("", "", "public");
      const { rows } = await getDb().execute(
        "SELECT COUNT(*) AS c FROM contact_preferences",
      );
      expect(Number(rows[0]!.c)).toBe(0);
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
        ledgerOrder: null,
        listings: ticketListings,
        modifierUsages: [],
        quantities,
      });
      expect(result.success).toBe(false);
      // Nothing persists for either listing — the partial booking is rolled back.
      expect((await getAttendeesRaw(e1.id)).length).toBe(0);
      expect((await getAttendeesRaw(e2.id)).length).toBe(0);
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
        ledgerOrder: null,
        listings: ticketListings,
        modifierUsages: [],
        quantities: new Map([
          [e1.id, 1],
          [e2.id, 2],
        ]),
      });
      expect(result.success).toBe(true);
      expect((await getAttendeesRaw(e1.id))[0]!.quantity).toBe(1);
      expect((await getAttendeesRaw(e2.id))[0]!.quantity).toBe(2);
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
        ledgerOrder: null,
        listings,
        modifierUsages: [],
        quantities: new Map([
          [parentId, 1],
          [childId, 1],
        ]),
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

    test("records the gross sale and the balance owed for a payments-enabled zero-total reservation", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const result = await createFreeReservation({
        contact,
        date: null,
        ledgerOrder: zeroTotalOrder(listing.id, 5000),
        listings: [await ticketListingFor(listing.id)],
        modifierUsages: [],
        quantities: new Map([[listing.id, 1]]),
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

      const { result, roundTrips } = await runWithQueryLogContext(async () => {
        enableQueryLog();
        const r = await createFreeReservation({
          contact,
          date: null,
          ledgerOrder,
          listings: await Promise.all(
            listings.map((l) => ticketListingFor(l.id)),
          ),
          modifierUsages: [],
          quantities: new Map(listings.map((l) => [l.id, 1])),
        });
        return {
          result: r,
          roundTrips: new Set(getQueryLog().map((q) => q.startedAtMs)).size,
        };
      });

      expect(result.success).toBe(true);
      // The N sale legs ride one batch, so the reservation's round-trips don't
      // scale with N (an interactive per-leg post would be ~2N and trip the guard).
      expect(roundTrips).toBeLessThanOrEqual(8);
    });

    test("rolls back and reports the add-on as sold out when its stock is gone", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const m = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "Add-on",
        stock: 0,
      });

      const result = await createFreeReservation({
        contact,
        date: null,
        // No provider configured, but the booking still carries a stock-limited
        // add-on: the create runs in a transaction to consume stock and rolls the
        // whole thing back when that add-on is gone, even with no ledger to post.
        ledgerOrder: null,
        listings: [await ticketListingFor(listing.id)],
        modifierUsages: [{ amountApplied: 500, modifierId: m.id, quantity: 1 }],
        quantities: new Map([[listing.id, 1]]),
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toBe(MODIFIER_SOLD_OUT_MESSAGE);
      // Nothing persisted — no attendee, and no orphaned ledger legs.
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
      expect((await allTransfers()).length).toBe(0);
    });
  });

  describe("bookingDateFields", () => {
    test("standard non-customisable booking spans a single dateless day", () => {
      const listing = testListingWithCount({ listing_type: "standard" });
      expect(bookingDateFields(listing, null, 3)).toEqual({
        date: null,
        durationDays: 1,
      });
    });

    test("daily non-customisable booking uses the listing's fixed duration", () => {
      const listing = testListingWithCount({
        duration_days: 4,
        listing_type: "daily",
      });
      expect(bookingDateFields(listing, "2026-07-01", 2)).toEqual({
        date: "2026-07-01",
        durationDays: 4,
      });
    });

    test("customisable daily booking spans the chosen day count", () => {
      const listing = testListingWithCount({
        customisable_days: true,
        day_prices: { 1: 1000, 3: 2500 },
        duration_days: 5,
        listing_type: "daily",
      });
      expect(bookingDateFields(listing, "2026-07-01", 3)).toEqual({
        date: "2026-07-01",
        durationDays: 3,
      });
    });

    test("customisable standard booking carries the day count but no date", () => {
      const listing = testListingWithCount({
        customisable_days: true,
        day_prices: { 2: 1800 },
        duration_days: 3,
        listing_type: "standard",
      });
      expect(bookingDateFields(listing, null, 2)).toEqual({
        date: null,
        durationDays: 2,
      });
    });
  });

  describe("buildRegistrationItems", () => {
    test("prices customisable listings by the chosen day count", () => {
      const listing = testListingWithCount({
        customisable_days: true,
        day_prices: { 1: 1000, 2: 1800 },
        duration_days: 3,
        id: 7,
        unit_price: 0,
      });
      const items = buildRegistrationItems(
        [buildTicketListing(listing, false, undefined)],
        new Map([[7, 1]]),
        new Map(),
        2,
      );
      expect(items[0]!.unitPrice).toBe(1800);
    });

    test("prices an unoffered day count at zero for a customisable listing", () => {
      const listing = testListingWithCount({
        customisable_days: true,
        day_prices: { 1: 1000 },
        duration_days: 3,
        id: 8,
      });
      const items = buildRegistrationItems(
        [buildTicketListing(listing, false, undefined)],
        new Map([[8, 1]]),
        new Map(),
        2,
      );
      expect(items[0]!.unitPrice).toBe(0);
    });

    test("prices non-customisable listings by custom or unit price", () => {
      const listing = testListingWithCount({ id: 9, unit_price: 500 });
      const items = buildRegistrationItems(
        [buildTicketListing(listing, false, undefined)],
        new Map([[9, 1]]),
        new Map(),
      );
      expect(items[0]!.unitPrice).toBe(500);
    });
  });

  describe("applyPackageOverrides", () => {
    const item = (listingId: number, unitPrice: number) => ({
      listingId,
      name: `L${listingId}`,
      quantity: 1,
      slug: `l${listingId}`,
      unitPrice,
    });

    test("returns items unchanged when there are no overrides", () => {
      const items = [item(1, 500)];
      expect(applyPackageOverrides(items, null, new Set([1]))).toBe(items);
      expect(applyPackageOverrides(items, new Map(), new Set([1]))).toBe(items);
    });

    test("overrides only top-level page listings carrying a price", () => {
      const items = [item(1, 500), item(2, 800), item(3, 0)];
      const prices = new Map([
        [1, 1200],
        [3, 999],
      ]);
      // Listing 1 is a page member with an override; 2 has none; 3 is a folded
      // child (not in the page set) so its override is ignored.
      const result = applyPackageOverrides(items, prices, new Set([1, 2]));
      expect(result.map((i) => i.unitPrice)).toEqual([1200, 800, 0]);
    });
  });

  describe("hidePackageMemberNames", () => {
    const item = (listingId: number, name: string) => ({
      listingId,
      name,
      quantity: 1,
      slug: `l${listingId}`,
      unitPrice: 500,
    });

    test("renames every item to the package name for a hidden package", () => {
      const items = [item(1, "Secret A"), item(2, "Secret B")];
      const result = hidePackageMemberNames(items, true, "Welcome Pack");
      expect(result.map((i) => i.name)).toEqual([
        "Welcome Pack",
        "Welcome Pack",
      ]);
      // Ids/prices/quantities are untouched so the webhook still revalidates.
      expect(result.map((i) => i.listingId)).toEqual([1, 2]);
    });

    test("is a no-op for a visible package or a missing name", () => {
      const items = [item(1, "Member")];
      expect(hidePackageMemberNames(items, false, "Pack")).toBe(items);
      expect(hidePackageMemberNames(items, true, undefined)).toBe(items);
    });
  });

  describe("loadPackageMemberMaps / getTicketContext packages", () => {
    test("loadPackageMemberMaps keeps overrides incl. free, skips no-override, and every quantity", async () => {
      const group = await createTestGroup({ isPackage: true, name: "Pk" });
      const a = await createTestListing({ name: "PA" });
      const b = await createTestListing({ name: "PB" });
      const c = await createTestListing({ name: "PC" });
      await setListingGroups(a.id, [group.id]);
      await setListingGroups(b.id, [group.id]);
      await setListingGroups(c.id, [group.id]);
      await setGroupPackageMembers(group.id, [
        { listingId: a.id, price: 1500, quantity: 2 },
        { listingId: b.id, price: 0 },
        { listingId: c.id, price: null },
      ]);

      const { prices, quantities } = await loadPackageMemberMaps(group.id);
      // A positive override and an explicit free (0) are both real prices kept
      // in the map; a null (no override) member is skipped so it falls back to
      // the listing's own price.
      expect(prices.get(a.id)).toBe(1500);
      expect(prices.get(b.id)).toBe(0);
      expect(prices.has(c.id)).toBe(false);
      // Quantities cover every member, including the override-free one.
      expect(quantities.get(a.id)).toBe(2);
      expect(quantities.get(b.id)).toBe(1);
      expect(quantities.get(c.id)).toBe(1);
    });

    test("getTicketContext exposes packageGroupId + prices for a package group", async () => {
      const group = await createTestGroup({ isPackage: true, name: "Ctx" });
      const a = await createTestListing({ name: "CA" });
      await setListingGroups(a.id, [group.id]);
      await setGroupPackageMembers(group.id, [
        { listingId: a.id, price: 2000 },
      ]);

      const ctx = await getTicketContext(
        [
          buildTicketListing(
            testListingWithCount({ id: a.id }),
            false,
            undefined,
          ),
        ],
        group,
      );
      expect(ctx.packageGroupId).toBe(group.id);
      expect(ctx.packagePrices?.get(a.id)).toBe(2000);
    });

    test("getTicketContext leaves package fields null for a non-package group", async () => {
      const group = await createTestGroup({ name: "Plain" });
      const ctx = await getTicketContext([], group);
      expect(ctx.packageGroupId).toBeNull();
      expect(ctx.packagePrices).toBeNull();
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

  describe("computeSharedDates", () => {
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
      });
      const dates = await computeSharedDates([
        buildTicketListing(listing, false, undefined),
      ]);
      // The last day in the 3-day window can't fit a 5-day span, yet it's still
      // offered as a start because availability is computed for a single day.
      expect(dates).toContain(addDays(todayInTz("UTC"), 3));
    });
  });

  describe("foldSelectedChildren — allocations", () => {
    /** Minimal TicketCtx stub for foldSelectedChildren tests. */
    const stubCtx = (
      listings: TicketListing[],
      childrenByParentId: import("#routes/public/types.ts").ChildrenByParentId,
    ): import("#routes/public/types.ts").TicketCtx => ({
      addOns: [],
      childDatesById: new Map(),
      childrenByParentId,
      dates: [],
      listings,
      packageGroupRemainingByGroupId: new Map(),
      packageMemberGroupIds: new Map(),
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
      const { setChildIds } = await import("#shared/db/listing-parents.ts");
      const parentA = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 10,
        name: "parentA",
      });
      await setChildIds(parentA.id, [child.id]);
      const parentB = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 10,
        name: "parentB",
      });
      await setChildIds(parentB.id, [child.id]);

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

// Pure (no DB) property tests over the per-parent fold algebra. Mutation testing
// confirmed the example-based fold suite is tight; these explore the input space
// the examples can't enumerate, pinning the core invariants directly.
describe("fold selection algebra (property-based)", () => {
  const PARENT_ID = 100;

  /** A bookable, high-capacity standard listing wrapped as a cart line. */
  const tl = (
    id: number,
    over: Partial<ListingWithCount> = {},
  ): TicketListing =>
    buildTicketListing(
      testListingWithCount({
        id,
        listing_type: "standard",
        max_attendees: 1000,
        max_quantity: 1000,
        name: `L${id}`,
        ...over,
      }),
      false,
      undefined,
    );

  const formFrom = (record: Record<string, string>): FormParams =>
    new FormParams(new URLSearchParams(record));

  test("resolveChildSelections accepts iff the chosen quantities sum to exactly the parent quantity", () => {
    fc.assert(
      fc.property(
        fc.integer({ max: 10, min: 1 }),
        fc.array(fc.integer({ max: 12, min: 0 }), {
          maxLength: 4,
          minLength: 1,
        }),
        (parentQty, qtys) => {
          const parent = tl(PARENT_ID);
          const children = qtys.map((_, i) => tl(i + 1));
          const record: Record<string, string> = {};
          qtys.forEach((q, i) => {
            record[`child_qty_${PARENT_ID}_${i + 1}`] = String(q);
          });
          const result = resolveChildSelections(
            parent,
            children,
            parentQty,
            formFrom(record),
          );
          const total = qtys.reduce((a, b) => a + b, 0);
          // A sole child with nothing submitted auto-fills the whole parent qty.
          const autoSelect = total === 0 && children.length === 1;
          if (total === parentQty || autoSelect) {
            if (!Array.isArray(result)) return false;
            const sum = result.reduce((acc, s) => acc + s.qty, 0);
            return sum === parentQty && result.every((s) => s.qty > 0);
          }
          return !Array.isArray(result);
        },
      ),
    );
  });

  test("resolveChildSelections rejects any positive quantity on a child not bookable under the parent", () => {
    fc.assert(
      fc.property(
        fc.integer({ max: 10, min: 1 }),
        fc.integer({ max: 50, min: 1 }),
        fc.integer({ max: 5, min: 1 }),
        (parentQty, strangerOffset, strangerQty) => {
          const parent = tl(PARENT_ID);
          const child = tl(1);
          // A valid sole-child selection summing to the parent quantity, PLUS a
          // positive quantity on a stranger id absent from the bookable set (a
          // sibling that sold out/closed between render and submit). The stranger
          // is never silently dropped — the whole submission is rejected.
          const strangerId = 1000 + strangerOffset;
          const record = {
            [`child_qty_${PARENT_ID}_1`]: String(parentQty),
            [`child_qty_${PARENT_ID}_${strangerId}`]: String(strangerQty),
          };
          const result = resolveChildSelections(
            parent,
            [child],
            parentQty,
            formFrom(record),
          );
          return !Array.isArray(result);
        },
      ),
    );
  });

  test("resolveChildSelections parses child quantities strictly, not via parseInt truncation", () => {
    // A tampered quantity is "none chosen" (0), never a truncated/garbage-parsed
    // number: child 1's strict "2" alone equals the parent quantity, so the order
    // is accepted and the malformed children are absent. The old parseInt parser
    // would read "2.9"->2 and "1abc"->1, inflating the total past 2 and wrongly
    // rejecting (or, on a sole child, booking a phantom quantity).
    const parent = tl(PARENT_ID);
    const result = resolveChildSelections(
      parent,
      [tl(1), tl(2), tl(3)],
      2,
      formFrom({
        [`child_qty_${PARENT_ID}_1`]: "2",
        [`child_qty_${PARENT_ID}_2`]: "2.9",
        [`child_qty_${PARENT_ID}_3`]: "1abc",
      }),
    );
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result.map((s) => s.child.listing.id)).toEqual([1]);
      expect(result.reduce((acc, s) => acc + s.qty, 0)).toBe(2);
    }
  });

  test("foldChild sums across folds and rejects (never clamps) above max-purchasable", () => {
    fc.assert(
      fc.property(
        fc.integer({ max: 20, min: 1 }),
        fc.array(fc.integer({ max: 8, min: 1 }), {
          maxLength: 6,
          minLength: 1,
        }),
        (max, qtys) => {
          const child = tl(1, { max_attendees: max, max_quantity: max });
          const state = {
            allocations:
              [] as import("#shared/db/attendee-types.ts").ChildAllocation[],
            customisableDuration: null,
            customPrices: new Map<number, number>(),
            listings: [] as TicketListing[],
            quantities: new Map<number, number>(),
            selectedListingIds: new Set<number>(),
          };
          let running = 0;
          for (const q of qtys) {
            const error = foldChild(state, child, q, 1, PARENT_ID, undefined);
            running += q;
            if (running <= max) {
              if (error !== null) return false; // must accept up to the cap
              if (state.quantities.get(1) !== running) return false; // exact sum
            } else {
              // First fold past the cap: rejected, and the over-cap quantity was
              // never written (the state mutation happens after the cap check).
              return error !== null && state.quantities.get(1) !== running;
            }
          }
          return true;
        },
      ),
    );
  });
});
