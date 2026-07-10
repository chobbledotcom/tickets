// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { addDays } from "#shared/dates.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import { todayInTz } from "#shared/timezone.ts";
import {
  assertPublicHtml,
  expectFlash,
  expectRedirect,
} from "#test-utils/assertions.ts";
import { getTicketCsrfToken, submitTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestHoliday } from "#test-utils/db-helpers/holidays.ts";
import { mockFormRequest, mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { createDailyListing } from "./daily-listing.ts";

// jscpd:ignore-end

describeWithEnv(
  "server public > daily listings (single ticket)",
  { db: true, triggers: true },
  () => {
    describe("daily listings (single ticket)", () => {
      // A valid bookable date: tomorrow (today + 1 day)
      const validDate = addDays(todayInTz("UTC"), 1);

      test("GET shows date selector for daily listing", async () => {
        const listing = await createDailyListing();
        await assertPublicHtml(
          `/ticket/${listing.slug}`,
          "Select Date",
          '<select name="date"',
        );
      });

      test("GET shows no-dates message when no dates available", async () => {
        // A daily listing where minimum_days_before > maximum_days_after so
        // the date range is empty (start > end)
        const listing = await createDailyListing({
          bookableDays: ["Monday"],
          maximumDaysAfter: 7,
          minimumDaysBefore: 30,
        });
        await assertPublicHtml(
          `/ticket/${listing.slug}`,
          "No dates are currently available for booking",
        );
      });

      test("POST succeeds for free daily listing with valid date", async () => {
        const listing = await createDailyListing();
        const response = await submitTicketForm(listing.slug, {
          date: validDate,
          email: "daily@example.com",
          name: "Daily User",
        });
        expectRedirect(response, "https://example.com/thanks");
      });

      test("POST rejects daily listing with missing date", async () => {
        const listing = await createDailyListing();
        const response = await submitTicketForm(listing.slug, {
          email: "daily@example.com",
          name: "Daily User",
        });
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("Please select a valid date"),
          false,
        );
      });

      test("POST rejects daily listing with invalid date", async () => {
        const listing = await createDailyListing();
        const response = await submitTicketForm(listing.slug, {
          date: "2099-01-01",
          email: "daily@example.com",
          name: "Daily User",
        });
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("Please select a valid date"),
          false,
        );
      });

      test("POST checks per-date capacity for daily listings", async () => {
        const listing = await createDailyListing({ maxAttendees: 1 });

        // Fill up the date
        await submitTicketForm(listing.slug, {
          date: validDate,
          email: "first@example.com",
          name: "First User",
        });

        // Second booking for same date is rejected by the date-aware gate
        // (#51: the page itself stays live — capacity is a per-date fact).
        const response = await submitTicketForm(listing.slug, {
          date: validDate,
          email: "second@example.com",
          name: "Second User",
        });
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("no longer has enough spots available"),
          false,
        );
      });

      test("POST allows booking different dates at capacity", async () => {
        const listing = await createDailyListing({ maxAttendees: 1 });

        // Book first date
        const response1 = await submitTicketForm(listing.slug, {
          date: validDate,
          email: "first@example.com",
          name: "First User",
        });
        expect(response1.status).toBe(302);

        // Book different date should succeed
        const otherDate = addDays(todayInTz("UTC"), 2);
        const response2 = await submitTicketForm(listing.slug, {
          date: otherDate,
          email: "second@example.com",
          name: "Second User",
        });
        expect(response2.status).toBe(302);
      });

      test("POST redirects to checkout for paid daily listing", async () => {
        await setupStripe();

        const listing = await createDailyListing({ unitPrice: 500 });

        const getResponse = await handleRequest(
          mockRequest(`/ticket/${listing.slug}`),
        );
        const csrfToken = getTicketCsrfToken(await getResponse.text());
        if (!csrfToken) throw new Error("Failed to get CSRF token");

        const response = await handleRequest(
          mockFormRequest(
            `/ticket/${listing.slug}`,
            {
              csrf_token: csrfToken,
              date: validDate,
              email: "paid@example.com",
              name: "Paid Daily User",
            },
            `csrf_token=${csrfToken}`,
          ),
        );
        expect(response.status).toBe(302);
        const location = response.headers.get("location");
        expect(location).not.toBeNull();

        resetStripeClient();
      });

      test("daily listing excludes holiday dates", async () => {
        // Create a holiday covering tomorrow
        await createTestHoliday({
          endDate: validDate,
          name: "Test Holiday",
          startDate: validDate,
        });

        const listing = await createDailyListing();
        const html = await assertPublicHtml(`/ticket/${listing.slug}`);
        // The holiday date should not appear as an option
        expect(html).not.toContain(`value="${validDate}"`);
      });
    });
  },
);
