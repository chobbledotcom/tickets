// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { bookingPageHtml, makeParent } from "#test-utils/parents.ts";
import {
  type ContainsCase,
  runContainsCases,
} from "#test-utils/parents-gate/helpers.ts";

// jscpd:ignore-end

/** A customisable parent priced 1 day £10 / 2 days £18 — the shared `parent`
 *  spec behind several price-label and every day-count-union case (declared
 *  once so the literal can't drift across the case tables). */
const oneOrTwoDayParent = {
  customisableDays: true,
  dayPrices: { 1: 1000, 2: 1800 },
  durationDays: 2,
};

/** A customisable child priced only for a 2-day span (unit_price 0) — the shared
 *  `children[0]` spec behind the day-count-union cases and the two non-table
 *  day-count render tests. */
const twoDayOnlyChild = {
  customisableDays: true,
  dayPrices: { 2: 2500 },
  durationDays: 2,
  maxPrice: 0,
  unitPrice: 0,
};

/** A customisable parent priced only for a 3-day span — the shared `parent` spec
 *  behind the two price-label cases whose parent offers only 3 days. */
const threeDayOnlyParent = {
  customisableDays: true,
  dayPrices: { 3: 5000 },
  durationDays: 3,
};

describeWithEnv(
  "server > parents gate > render: price labels & day-count union",
  { db: true, triggers: true },
  () => {
    // Price-label rendering: build a customisable parent+child, render the
    // booking page, and assert the child's option label contains / omits a
    // particular price string. Each row supplies its makeParent spec plus the
    // contains/notContains assertions.
    const PRICE_LABEL_CASES: ContainsCase[] = [
      // A fixed-duration (standard) parent inherits duration 1; the customisable
      // child's label must show its 1-day price (10.00), never its unit_price
      // (0, which would advertise "free" while checkout charges the day price).
      // The sole child renders informationally; its label carries the day price,
      // not "£0".
      {
        contains: ["Customisable add-on", "(£10"],
        name: "a customisable child's option label shows the inherited day price, not its unit_price",
        notContains: ["(£0"],
        spec: {
          children: [
            {
              customisableDays: true,
              dayPrices: { 1: 1000 },
              durationDays: 1,
              maxPrice: 0,
              name: "Customisable add-on",
              unitPrice: 0,
            },
          ],
        },
      },
      // A customisable parent has no single render-time duration, so its
      // customisable child's label shows "from <min day price>" (15.00).
      {
        contains: ["Customisable add-on", "(from £15"],
        name: "a customisable child under a customisable parent shows a 'from' price",
        notContains: [],
        spec: {
          children: [
            {
              customisableDays: true,
              dayPrices: { 1: 1500, 2: 2500 },
              durationDays: 2,
              maxPrice: 0,
              name: "Customisable add-on",
              unitPrice: 0,
            },
          ],
          parent: oneOrTwoDayParent,
        },
      },
      // The parent can only offer a 3-day span; the child is priced 1 day £10,
      // 3 days £25. The label must show the price for a span the parent can
      // actually book (£25), not the child's own cheapest span (£10) the parent
      // can never select.
      {
        contains: ["(from £25"],
        name: "a 'from' price uses the parent∩child spans, not the child's lowest",
        notContains: ["(from £10"],
        spec: {
          children: [
            {
              customisableDays: true,
              dayPrices: { 1: 1000, 3: 2500 },
              durationDays: 3,
              maxPrice: 0,
              unitPrice: 0,
            },
          ],
          parent: threeDayOnlyParent,
        },
      },
      // The parent offers only a 3-day span; the child is priced only for 1 day.
      // With no overlapping span the label omits the price entirely (the edge
      // isn't bookable anyway).
      {
        contains: ["One-day add-on"],
        name: "a 'from' price is omitted when parent and child spans don't overlap",
        notContains: ["One-day add-on (from", "One-day add-on (£"],
        spec: {
          children: [
            {
              customisableDays: true,
              dayPrices: { 1: 1000 },
              durationDays: 1,
              maxPrice: 0,
              name: "One-day add-on",
              unitPrice: 0,
            },
          ],
          parent: threeDayOnlyParent,
        },
      },
      // The fixed daily parent inherits duration 3, but the child has no 3-day
      // price — the label omits the price rather than advertising a wrong one.
      // The option appears with no price suffix (no "(£" after the name).
      {
        contains: ["Two-day add-on"],
        name: "a customisable child unpriced for a fixed parent's duration shows no price",
        notContains: ["Two-day add-on (£", "Two-day add-on (from"],
        spec: {
          children: [
            {
              customisableDays: true,
              dayPrices: { 2: 2000 },
              durationDays: 2,
              maxPrice: 0,
              name: "Two-day add-on",
              unitPrice: 0,
            },
          ],
          parent: { daily: true, durationDays: 3 },
        },
      },
    ];
    runContainsCases(PRICE_LABEL_CASES);

    // Day-count-union rendering on a SINGLE-listing customisable parent page:
    // build the parent+child, render, and assert which "<n> day(s)" labelled
    // options the selector offers. (The labelled "<n> day(s)" string is the
    // day-count option — the bare `<option value="1">` of the quantity selector
    // is a different control, so the assertions key on the labelled option.)
    const DAY_COUNT_UNION_CASES: ContainsCase[] = [
      // The parent prices {1,2} days; its only child prices only 2 days. The
      // rendered day-count selector must offer only the 2-day option — the
      // 1-day option the submit fold would reject is gone.
      {
        contains: [">2 days"],
        name: "a customisable parent offers only day counts its child can serve",
        notContains: [">1 day"],
        spec: {
          children: [twoDayOnlyChild],
          parent: oneOrTwoDayParent,
        },
      },
      // The child prices both 1 and 2 days, so the parent keeps both options
      // (the union covers every parent span).
      {
        contains: [">1 day", ">2 days"],
        name: "a customisable parent keeps day counts a child supports both of",
        notContains: [],
        spec: {
          children: [
            {
              customisableDays: true,
              dayPrices: { 1: 1500, 2: 2500 },
              durationDays: 2,
              maxPrice: 0,
              unitPrice: 0,
            },
          ],
          parent: oneOrTwoDayParent,
        },
      },
      // The parent offers {1,2,3} days; its only required child is a FIXED 2-day
      // daily listing, whose supported span is exactly its duration_days (2). The
      // day-count selector must therefore offer only the 2-day option — a daily
      // child must NOT be treated as imposing "any" span (which would keep all of
      // {1,2,3}), it constrains to its own fixed duration (dayCountsChildSupports).
      // Only the child's own 2-day span is offered; the 1- and 3-day options the
      // child cannot serve are dropped from the union.
      {
        contains: [">2 days"],
        name: "a customisable parent's day counts are constrained to a fixed daily child's own span",
        notContains: [">1 day", ">3 days"],
        spec: {
          children: [{ daily: true, durationDays: 2 }],
          parent: {
            customisableDays: true,
            dayPrices: { 1: 1000, 2: 1800, 3: 2500 },
            durationDays: 3,
          },
        },
      },
    ];
    runContainsCases(DAY_COUNT_UNION_CASES);

    test("a multi-listing page does NOT constrain the shared day counts by one parent's child", async () => {
      // The day-count union constraint is SINGLE-listing only: on a multi-listing
      // page the day-count selector is shared, so a parent's restrictive child must
      // not remove a span a sibling page listing still needs (the per-parent
      // constraint is deferred to JS + the submit fold). Page = a customisable
      // parent (child supports only 2 days) PLUS a plain customisable listing
      // offering {1,2}: the shared selector must keep BOTH the 1- and 2-day options.
      const { parent } = await makeParent({
        children: [twoDayOnlyChild],
        parent: oneOrTwoDayParent,
      });
      const sibling = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1200, 2: 2000 },
        durationDays: 2,
        name: "Sibling listing",
      });

      const html = await bookingPageHtml(`${parent.slug}+${sibling.slug}`);
      // Both options survive: the multi-listing page is not constrained by the
      // parent's 2-day-only child (which on its own page would drop the 1-day).
      expect(html).toContain(">1 day");
      expect(html).toContain(">2 days");
    });

    test("a customisable parent builds its day-count union from SELECTABLE children only", async () => {
      // An INACTIVE 1-day child must contribute no spans (and must not preserve
      // every parent span via its "any" null result); the ACTIVE 2-day child
      // alone drives the union, so only the 2-day option renders.
      const { parent, children } = await makeParent({
        children: [{ maxPrice: 0, unitPrice: 0 }, twoDayOnlyChild],
        parent: oneOrTwoDayParent,
      });
      const inactiveOneDay = children[0]!;
      await deactivateTestListing(inactiveOneDay.id);

      const html = await bookingPageHtml(parent.slug);
      expect(html).toContain(">2 days");
      expect(html).not.toContain(">1 day");
    });
  },
);
