import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { parseQuantityValue } from "#routes/public/ticket-form.ts";
import {
  bookingDateFields,
  buildRegistrationItems,
  computeSharedDates,
  createFreeReservation,
  MODIFIER_SOLD_OUT_MESSAGE,
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
import { getListingWithCount } from "#shared/db/listings.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
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
        ledgerOrder: zeroTotalOrder(listing.id, 5000),
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
});
