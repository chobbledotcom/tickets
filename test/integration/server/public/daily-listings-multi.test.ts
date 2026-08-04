// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { addDays } from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
import {
  ALL_WEEKDAYS,
  createDailyListing,
} from "#test/integration/server/public/daily-listing.ts";
import {
  assertPublicHtml,
  expectFlash,
  expectReservedRedirectWithTokens,
} from "#test-utils/assertions.ts";
import {
  bookTwoListingsAsTestUser,
  submitMultiTicketForm,
} from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupStripe } from "#test-utils/settings.ts";

// jscpd:ignore-end

describeWithEnv(
  "server public > daily listings (ticket)",
  { db: true, triggers: true },
  () => {
    describe("daily listings (ticket)", () => {
      const validDate = addDays(todayInTz("UTC"), 1);

      test("GET shows date selector for ticket with daily listings", async () => {
        const listing1 = await createDailyListing();
        const listing2 = await createDailyListing();
        await assertPublicHtml(
          `/ticket/${listing1.slug}+${listing2.slug}`,
          "Select Date",
          '<select name="date"',
        );
      });

      test("POST rejects ticket daily listing without date", async () => {
        const listing1 = await createDailyListing();
        const listing2 = await createDailyListing();

        const response = await bookTwoListingsAsTestUser(
          `${listing1.slug}+${listing2.slug}`,
          listing1.id,
          "1",
          listing2.id,
          "1",
        );
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("Please select a valid date"),
          false,
        );
      });

      test("POST succeeds for free ticket daily listings with valid date", async () => {
        const listing1 = await createDailyListing();
        const listing2 = await createDailyListing();

        const response = await submitMultiTicketForm(
          `${listing1.slug}+${listing2.slug}`,
          {
            date: validDate,
            email: "multidaily@example.com",
            name: "Multi Daily User",
            [`quantity_${listing1.id}`]: "1",
            [`quantity_${listing2.id}`]: "1",
          },
        );
        expectReservedRedirectWithTokens(response);
      });

      test("POST redirects to checkout for paid ticket daily listings", async () => {
        await setupStripe();

        const listing1 = await createDailyListing({ unitPrice: 500 });
        const listing2 = await createDailyListing({ unitPrice: 300 });

        const response = await submitMultiTicketForm(
          `${listing1.slug}+${listing2.slug}`,
          {
            date: validDate,
            email: "multipaid@example.com",
            name: "Multi Daily Paid",
            [`quantity_${listing1.id}`]: "1",
            [`quantity_${listing2.id}`]: "1",
          },
        );
        expect(response.status).toBe(302);
        const location = response.headers.get("location");
        expect(location).not.toBeNull();
      });

      test("shows date and location on ticket page when listings have them", async () => {
        const listing1 = await createTestListing({
          date: "2026-06-15T14:00",
          location: "Village Hall",
          maxAttendees: 50,
          name: "Multi Date 1",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          name: "Multi Date 2",
        });
        // Listing 1 has date and location, listing 2 does not
        await assertPublicHtml(
          `/ticket/${listing1.slug}+${listing2.slug}`,
          "Multi Date 1",
          "Multi Date 2",
        );
      });

      test("computes shared dates across daily listings", async () => {
        // listing1: only bookable on Monday, listing2: bookable all days
        // Shared dates should only be Mondays
        const listing1 = await createDailyListing({
          bookableDays: ["Monday"],
        });
        const listing2 = await createDailyListing();
        // Should contain Monday dates but not Tuesday dates
        const html = await assertPublicHtml(
          `/ticket/${listing1.slug}+${listing2.slug}`,
          "Monday",
        );
        expect(html).not.toContain("Tuesday");
      });
    });

    describe("cart conflict notes", () => {
      test("names both listings when their booking windows never overlap", async () => {
        // 0-2 days out vs 5-7 days out: each has dates, none shared.
        const near = await createDailyListing({
          maximumDaysAfter: 2,
          name: "Near Window",
        });
        const far = await createDailyListing({
          maximumDaysAfter: 7,
          minimumDaysBefore: 5,
          name: "Far Window",
        });
        await assertPublicHtml(
          `/ticket/${near.slug}+${far.slug}`,
          "'Near Window' and 'Far Window' do not share an available date. Book them separately.",
        );
      });

      test("names the listing that has no dates at all", async () => {
        // A one-day window (tomorrow only, since maximum_days_after 0 means
        // "no maximum") whose weekday the listing excludes, so it can never
        // offer a date whatever day the test runs.
        const tomorrow = new Date(`${addDays(todayInTz("UTC"), 1)}T00:00:00Z`);
        const tomorrowName = tomorrow.toLocaleDateString("en-US", {
          timeZone: "UTC",
          weekday: "long",
        });
        const dateless = await createDailyListing({
          bookableDays: ALL_WEEKDAYS.filter((day) => day !== tomorrowName),
          maximumDaysAfter: 1,
          minimumDaysBefore: 1,
          name: "Never Open",
        });
        const open = await createDailyListing({ name: "Always Open" });
        await assertPublicHtml(
          `/ticket/${dateless.slug}+${open.slug}`,
          "'Never Open' has no dates available. Book the others without it.",
        );
      });

      test("names both listings when no booking length suits them all", async () => {
        const short = await createDailyListing({
          customisableDays: true,
          dayPrices: { 1: 500 },
          durationDays: 1,
          name: "Short Stay",
          unitPrice: 500,
        });
        const long = await createDailyListing({
          customisableDays: true,
          dayPrices: { 3: 900 },
          durationDays: 3,
          name: "Long Stay",
          unitPrice: 900,
        });
        await assertPublicHtml(
          `/ticket/${short.slug}+${long.slug}`,
          "'Short Stay' and 'Long Stay' do not share a booking length. Book them separately.",
        );
      });

      test("shows no conflict note when the listings get along", async () => {
        const listing1 = await createDailyListing({ name: "Friendly One" });
        const listing2 = await createDailyListing({ name: "Friendly Two" });
        const html = await assertPublicHtml(
          `/ticket/${listing1.slug}+${listing2.slug}`,
          "Friendly One",
        );
        expect(html).not.toContain("Book them separately");
        expect(html).not.toContain("has no dates available");
      });
    });
  },
);
