// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getBookableStartDates, isBookingRangeValid } from "#shared/dates.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { getListingWithCount } from "#shared/db/listings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestHoliday } from "#test-utils/db-helpers/holidays.ts";
import {
  bookableStartDates,
  createDailyTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { bookingPageHtml, makeParent } from "#test-utils/parents.ts";
import { weekdayOf } from "../booking-model-fixtures.ts";
import { firstBookableDate } from "./helpers.ts";

// jscpd:ignore-end

describeWithEnv(
  "server > parents gate > render: child compat data",
  { db: true, triggers: true },
  () => {
    test("a daily child required by two parents carries each parent's own data-child-dates", async () => {
      // The SAME daily child is required by two daily parents on different
      // calendars (parent A bookable only Mondays, parent B only Tuesdays). Each
      // parent's block must carry the child's serveable dates FOR THAT PARENT —
      // keyed by the (parent, child) pair. A map keyed by child
      // id alone, so the second parent overwrote the first and both blocks showed
      // the same (later parent's) dates.
      // Each parent gets a SECOND child so the shared child renders as a
      // selectable `child_qty_*` option (carrying data-child-dates) rather than
      // the informational sole-child path (which emits no compat attributes).
      const parentA = await createDailyTestListing({
        bookableDays: ["Monday"],
        name: "Monday base",
      });
      const parentB = await createDailyTestListing({
        bookableDays: ["Tuesday"],
        name: "Tuesday base",
      });
      const shared = await createDailyTestListing({ name: "Shared add-on" });
      const extraA = await createDailyTestListing({ name: "Extra A" });
      const extraB = await createDailyTestListing({ name: "Extra B" });
      await listingChildren.setIds(parentA.id, [shared.id, extraA.id]);
      await listingChildren.setIds(parentB.id, [shared.id, extraB.id]);

      const mondayDate = await firstBookableDate(parentA.id);
      const tuesdayDate = await firstBookableDate(parentB.id);
      expect(mondayDate).not.toBe(tuesdayDate);

      const html = await bookingPageHtml(`${parentA.slug}+${parentB.slug}`);

      // Isolate each parent's control for the shared child and read its dates.
      const datesAttr = (parentId: number): string => {
        const start = html.indexOf(`name="child_qty_${parentId}_${shared.id}"`);
        expect(start).toBeGreaterThanOrEqual(0);
        const select = html.slice(start, html.indexOf(">", start));
        const match = select.match(/data-child-dates="([^"]*)"/);
        return match?.[1] ?? "";
      };

      // Parent A's block lists the shared child as serveable on its Monday only;
      // parent B's on its Tuesday only — each parent's own calendar, not shared.
      expect(datesAttr(parentA.id)).toContain(mondayDate);
      expect(datesAttr(parentA.id)).not.toContain(tuesdayDate);
      expect(datesAttr(parentB.id)).toContain(tuesdayDate);
      expect(datesAttr(parentB.id)).not.toContain(mondayDate);
    });

    test("a sole daily child carries its compatibility data on the informational marker", async () => {
      // On a parent page the sole child renders informationally (no quantity
      // control). Without carrying `data-child-dates`, on a group /
      // multi-listing page the client compat script couldn't tell the auto-selected
      // sole child can't serve the chosen date — the buyer saw "Includes …" and hit
      // the submit-side rejection. The marker must now carry the same compat data a
      // selectable child option does, keyed to the fixed parent span (1).
      const { parent, child } = await makeParent({
        children: [{ daily: true }],
        parent: { daily: true },
      });

      const childDates = (await bookableStartDates(child.id)).join(",");

      const html = await bookingPageHtml(parent.slug);
      // The sole-child marker carries the span-keyed serveable dates.
      const marker = html.slice(html.indexOf(`data-sole-child="${child.id}"`));
      const block = marker.slice(0, marker.indexOf(">"));
      expect(block).toContain(`data-child-dates="1:${childDates}"`);
      expect(childDates.length).toBeGreaterThan(0);
    });

    test("a customisable parent's daily child advertises a date set per span", async () => {
      // A customisable daily parent offers spans {1,2}. A daily child can start a
      // given day for a 1-day span, but a holiday on the next day makes the 2-day
      // span starting that day invalid. The child's `data-child-dates` must carry
      // the date PER span — that start appears in the 1-day set but NOT the 2-day
      // set — so the client picks the right set for the chosen day_count rather
      // than offering a Monday the 2-day fold rejects. A second daily child keeps
      // the per-child selectors rendered (no sole-child auto-select).
      const { parent, children } = await makeParent({
        children: [{ daily: true }, { daily: true }],
        parent: {
          customisableDays: true,
          daily: true,
          dayPrices: { 1: 1000, 2: 1800 },
          durationDays: 2,
        },
      });
      const childA = children[0]!;

      // Put a holiday on the day AFTER child A's first serveable start, so a 2-day
      // span from that start is invalid while a 1-day span is fine.
      const childARow = (await getListingWithCount(childA.id))!;
      const baseHolidays = await getActiveHolidays();
      const starts = getBookableStartDates(childARow, baseHolidays);
      const splitStart = starts[0]!;
      const nextDay = new Date(`${splitStart}T00:00:00Z`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      const holidayDate = nextDay.toISOString().slice(0, 10);
      await createTestHoliday({ endDate: holidayDate, startDate: holidayDate });

      const holidays = await getActiveHolidays();
      const oneDay = getBookableStartDates(childARow, holidays).filter((d) =>
        isBookingRangeValid(childARow, d, 1, holidays),
      );
      const twoDay = getBookableStartDates(childARow, holidays).filter((d) =>
        isBookingRangeValid(childARow, d, 2, holidays),
      );
      // The setup must actually split the two spans (else the test proves nothing).
      expect(oneDay).toContain(splitStart);
      expect(twoDay).not.toContain(splitStart);

      const html = await bookingPageHtml(parent.slug);
      const control = html.slice(
        html.indexOf(`name="child_qty_${parent.id}_${childA.id}"`),
      );
      const attrs = control.slice(0, control.indexOf(">"));
      const dates = attrs.match(/data-child-dates="([^"]*)"/)?.[1] ?? "";
      expect(dates).toBe(`1:${oneDay.join(",")}|2:${twoDay.join(",")}`);
    });

    test("a daily parent's daily child carries its serveable dates as data-child-dates", async () => {
      // Two daily children so the per-child selectors render (no sole-child
      // auto-select): child A serves every day, child B only one weekday — so the
      // client compatibility script can tell them apart by their date sets.
      const parent = await createDailyTestListing({ name: "Daily base" });
      const childA = await createDailyTestListing({ name: "Daily add-on A" });
      const parentDate = await firstBookableDate(parent.id);
      const parentDay = weekdayOf(parentDate);
      const childB = await createDailyTestListing({
        bookableDays: [parentDay],
        name: "Daily add-on B",
      });
      await listingChildren.setIds(parent.id, [childA.id, childB.id]);

      const childBRow = (await getListingWithCount(childB.id))!;
      // Mark an active holiday on one of child B's serveable starts. The server's
      // child-date set must be HOLIDAY-AWARE: it computes the dates with the
      // active holidays, so this date is excluded from `data-child-dates`. (If the
      // render path dropped the holidays it would re-appear — this pins the fetch.)
      const childBStarts = await bookableStartDates(childB.id);
      const holidayDate = childBStarts[1]!;
      await createTestHoliday({ endDate: holidayDate, startDate: holidayDate });

      const refreshedHolidays = await getActiveHolidays();
      const childBDates = getBookableStartDates(
        childBRow,
        refreshedHolidays,
      ).join(",");

      const html = await bookingPageHtml(parent.slug);
      // Child B's control advertises exactly its own (single-weekday) serveable
      // dates — the holiday-aware set the server computed, not the parent's. The
      // fixed daily parent's one inherited span (1) keys the span-aware encoding
      // `span:dates`.
      expect(html).toContain(
        `name="child_qty_${parent.id}_${childB.id}" data-child-qty="${childB.id}" data-child-dates="1:${childBDates}"`,
      );
      expect(childBDates.length).toBeGreaterThan(0);
      // The holiday start must have been removed from the advertised set.
      expect(childBDates).not.toContain(holidayDate);
      expect(html).not.toContain(
        `data-child-dates="1:${childBStarts.join(",")}"`,
      );
    });

    test("a customisable child carries its supported spans as data-child-spans", async () => {
      // Two children so the per-child selectors render: a customisable child
      // (priced 1 & 3 days) advertises its supported spans; a plain standard
      // child carries no span attribute (always compatible).
      const { parent, children } = await makeParent({
        children: [
          {
            customisableDays: true,
            dayPrices: { 1: 1000, 3: 3000 },
            durationDays: 3,
            maxPrice: 0,
            unitPrice: 0,
          },
          {},
        ],
        parent: {
          customisableDays: true,
          dayPrices: { 1: 1000, 3: 3000 },
          durationDays: 3,
        },
      });
      const [childA, childB] = [children[0]!, children[1]!];

      const html = await bookingPageHtml(parent.slug);
      // The customisable child advertises the spans it can serve.
      expect(html).toContain(
        `name="child_qty_${parent.id}_${childA.id}" data-child-qty="${childA.id}" data-child-spans="1,3"`,
      );
      // The standard child imposes no span constraint, so it emits neither attr.
      const standardControl = html.slice(
        html.indexOf(`name="child_qty_${parent.id}_${childB.id}"`),
      );
      expect(standardControl).not.toContain("data-child-spans");
      expect(standardControl.slice(0, 120)).not.toContain("data-child-dates");
    });
  },
);
