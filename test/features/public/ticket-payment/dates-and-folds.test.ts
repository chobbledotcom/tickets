/**
 * The date and day-count suites for the booking payment flow: the chosen
 * day count's validation, each daily listing's own bookable starts, and the
 * allocations the submitted fold records. Split from
 * ticket-payment.test.ts so both files stay small.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildTicketListing, type TicketListing } from "#booking/model.ts";
import { listingChildren } from "#db/listing-parents.ts";
import {
  dailyDateItems,
  resolveDayCount,
} from "#routes/public/booking-dates.ts";
import { loadChildrenByParentId } from "#routes/public/child-listings.ts";
import { foldSelectedChildren } from "#routes/public/ticket-payment.ts";
import type { ChildrenByParentId, TicketCtx } from "#routes/public/types.ts";
import { addDays } from "#shared/dates.ts";
import { FormParams } from "#shared/form-data.ts";
import { todayInTz } from "#shared/timezone.ts";
import { testDate } from "#test-utils/dates.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import { makeParent } from "#test-utils/parents.ts";
import { ticketListingFor } from "./helpers.ts";
import type { ListingWithCount } from "#types";

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

describeWithEnv("routes > public > ticket-payment dates", { db: true }, () => {
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
      // The day can't fit a 5-day span, yet it's offered as a start.
      expect(items[0]).toMatchObject({
        dates: expect.arrayContaining([addDays(testDate(todayInTz("UTC")), 3)]),
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
      childrenByParentId: ChildrenByParentId,
    ): TicketCtx => ({
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
      pageHidden: false,
      questionListingMap: new Map(),
      questions: [],
      slugs: [],
      terms: "",
    });

    const doFold = (
      ctx: TicketCtx,
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
