// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { DAY_NAMES } from "#shared/day-names.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  bookableStartDates,
  createDailyTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { bookingPageHtml, makeParent } from "#test-utils/parents.ts";
import { weekdayOf } from "../booking-model-fixtures.ts";
import {
  firstBookableDate,
  makeDailyChildFilledOnDayA,
  selectOptionsFromHtml,
} from "./helpers.ts";

// jscpd:ignore-end

describeWithEnv(
  "server > parents gate > render: dates & spans",
  { db: true, triggers: true },
  () => {
    test("a daily child full on one date still renders bookable; the parent qty is not clamped to 0", async () => {
      // Render regression: a 1-capacity daily child full on ANY single
      // date reads `isSoldOut` date-lessly, but the render predicate must NOT use
      // that aggregate for a daily child (its per-date capacity is the fold's
      // job). Before the fix the child rendered disabled and `childCappedMax`
      // clamped the parent's quantity to 0 on every date; after it the parent
      // still offers a bookable quantity and the child a per-unit select.
      const { parent, child } = await makeParent({
        children: [{ daily: true, maxAttendees: 1 }],
        parent: { daily: true, maxQuantity: 5 },
      });

      // Fill the child's single spot on its first bookable date.
      const dayA = await firstBookableDate(child.id);
      expect((await bookAttendee(child, { date: dayA })).success).toBe(true);

      const html = await bookingPageHtml(parent.slug);
      // The parent's quantity selector still offers a bookable quantity (the
      // date-less sold-out child did NOT clamp it to 0).
      const options = selectOptionsFromHtml(html, `quantity_${parent.id}`);
      expect(options).toContain('value="1"');
      // The sole daily child renders informational (auto-selected), not disabled.
      expect(html).toContain(`data-sole-child="${child.id}"`);
      expect(html).not.toMatch(
        new RegExp(
          `<select name="child_qty_${parent.id}_${child.id}"[^>]*\\sdisabled`,
        ),
      );
    });

    test("a daily parent offers only dates its only child can serve", async () => {
      // The daily parent is bookable every day, but its only (daily) child is
      // bookable on a single weekday. The rendered date selector must offer only
      // the child's dates (parentDates ∩ child union), never a parent-only date
      // the submit fold would reject.
      const parent = await createDailyTestListing({ name: "Daily base" });
      const parentDates = await bookableStartDates(parent.id);
      const childDate = parentDates[0]!;
      const childDay = weekdayOf(childDate);
      // A daily child bookable only on the first parent date's weekday.
      const child = await createDailyTestListing({
        bookableDays: [childDay],
        name: "Daily add-on",
      });
      await listingChildren.setIds(parent.id, [child.id]);

      const childDates = await bookableStartDates(child.id);
      const otherDate = parentDates.find((d) => !childDates.includes(d))!;

      const html = await bookingPageHtml(parent.slug);
      // Every child date is offered; a parent-only date is not.
      for (const d of childDates) {
        expect(html).toContain(`<option value="${d}"`);
      }
      expect(html).not.toContain(`<option value="${otherDate}"`);
    });

    test("a daily parent with a dateless child keeps all its dates", async () => {
      // A STANDARD (dateless) child imposes no date constraint, so the parent
      // keeps every one of its own bookable dates.
      const { parent } = await makeParent({ parent: { daily: true } });

      const parentDates = await bookableStartDates(parent.id);

      const html = await bookingPageHtml(parent.slug);
      for (const d of parentDates) {
        expect(html).toContain(`<option value="${d}"`);
      }
    });

    test("a daily parent builds its date union from SELECTABLE children only", async () => {
      // ACTIVE child bookable only Monday, INACTIVE child bookable only Tuesday.
      // The inactive child must contribute NOTHING to the union, so only Monday
      // is offered — its Tuesday must never become selectable.
      const parent = await createDailyTestListing({ name: "Daily base" });
      const parentDates = await bookableStartDates(parent.id);
      const mondayDate = parentDates[0]!;
      const tuesdayDate = parentDates.find((d) => d !== mondayDate)!;
      const mondayName = weekdayOf(mondayDate);
      const tuesdayName = weekdayOf(tuesdayDate);

      const activeChild = await createDailyTestListing({
        bookableDays: [mondayName],
        name: "Active add-on",
      });
      const inactiveChild = await createDailyTestListing({
        bookableDays: [tuesdayName],
        name: "Inactive add-on",
      });
      await listingChildren.setIds(parent.id, [
        activeChild.id,
        inactiveChild.id,
      ]);
      await deactivateTestListing(inactiveChild.id);

      const html = await bookingPageHtml(parent.slug);
      expect(html).toContain(`<option value="${mondayDate}"`);
      // The inactive child's Tuesday must NOT be offered.
      expect(html).not.toContain(`<option value="${tuesdayDate}"`);
    });

    test("a fixed-span daily parent drops a child date with no valid full-span start", async () => {
      // A fixed 3-day parent with a customisable child priced for 3 days but
      // bookable only on Mondays: a 3-day span starting Monday needs Mon+Tue+Wed
      // all bookable for the child, which it is not, so Monday must NOT be offered
      // (the union validates the inherited fixed span with
      // isBookingRangeValid, not single-day starts).
      const parent = await createDailyTestListing({
        durationDays: 3,
        name: "Fixed 3-day base",
      });
      const parentDates = await bookableStartDates(parent.id);
      const mondayDate = parentDates[0]!;
      const mondayName = weekdayOf(mondayDate);

      const child = await createDailyTestListing({
        bookableDays: [mondayName],
        customisableDays: true,
        dayPrices: { 1: 1000, 2: 1800, 3: 2500 },
        durationDays: 3,
        maxPrice: 0,
        name: "Mon-only add-on",
        unitPrice: 0,
      });
      await listingChildren.setIds(parent.id, [child.id]);

      const html = await bookingPageHtml(parent.slug);
      // No Monday→Wednesday span is valid for the child, so Monday is not offered.
      expect(html).not.toContain(`<option value="${mondayDate}"`);
    });

    test("a customisable daily parent offers a fixed daily child's full-span starts, not single days", async () => {
      // The parent is CUSTOMISABLE daily (no fixed span at render). For a daily
      // child the union must use the child's OWN bookable START dates
      // (getBookableStartDates), which for a FIXED 3-day daily child are the days a
      // whole 3-day span fits — NOT the parent dates filtered by a single day. The
      // child is bookable only Mon+Tue+Wed: a 3-day span fits only from Monday, but
      // each of Mon/Tue/Wed is bookable as a single day. The correct render offers
      // Monday only; swapping to the fixed-span branch (which, with no fixed span,
      // degrades to a single-day validity filter) would also offer Tuesday — so the
      // branch swap is caught by Tuesday's absence.
      // A FIXED 3-day daily child bookable only on Mon/Tue/Wed: only a Monday
      // start fits a whole 3-day Mon-Tue-Wed span.
      const { parent } = await makeParent({
        children: [
          {
            bookableDays: ["Monday", "Tuesday", "Wednesday"],
            daily: true,
            durationDays: 3,
          },
        ],
        parent: {
          customisableDays: true,
          daily: true,
          dayPrices: { 1: 1000, 2: 1800, 3: 2500 },
          durationDays: 3,
        },
      });
      const parentDates = await bookableStartDates(parent.id);
      const monIdx = DAY_NAMES.indexOf("Monday");
      const tueIdx = DAY_NAMES.indexOf("Tuesday");
      // A Monday in the parent's dates and the Tuesday in the parent's dates that
      // immediately follows it (so both are genuinely offerable parent dates).
      const mondayDate = parentDates.find(
        (d) => new Date(`${d}T00:00:00Z`).getUTCDay() === monIdx,
      )!;
      const tuesdayDate = parentDates.find(
        (d) =>
          new Date(`${d}T00:00:00Z`).getUTCDay() === tueIdx && d > mondayDate,
      )!;

      const html = await bookingPageHtml(parent.slug);
      // Monday (a valid full 3-day child start) is offered.
      expect(html).toContain(`<option value="${mondayDate}"`);
      // Tuesday is bookable single-day but starts no full 3-day span, so the
      // customisable parent must NOT offer it.
      expect(html).not.toContain(`<option value="${tuesdayDate}"`);
    });

    test("a daily child full on one date does not make its parent render sold out", async () => {
      // A 1-capacity daily child fully booked on one date reads date-less
      // isSoldOut=true, but the parent page must still render a bookable form —
      // the daily child is potentially bookable on the dates it still has room
      // for. The submit fold rejects only a genuinely full date.
      // The render also keeps the daily child a BOOKABLE option (its date-less
      // sold-out aggregate is exempt), so it auto-selects as the sole child
      // instead of rendering a disabled control. (See the render test above
      // for the parent-quantity-not-clamped-to-0 outcome.)
      const { parent, child } = await makeDailyChildFilledOnDayA();

      const html = await bookingPageHtml(parent.slug);
      // The parent renders a normal bookable form, not the sold-out message.
      expect(html).toContain(`name="quantity_${parent.id}"`);
      // The daily child is the sole bookable option, rendered
      // informational — never as a disabled control.
      expect(html).toContain(`data-sole-child="${child.id}"`);
      expect(html).not.toContain("Sorry, this listing is full.");
    });
  },
);
