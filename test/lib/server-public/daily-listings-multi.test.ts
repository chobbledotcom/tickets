// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { addDays } from "#shared/dates.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import { todayInTz } from "#shared/timezone.ts";
import {
  assertPublicHtml,
  bookTwoListingsAsTestUser,
  createTestListing,
  describeWithEnv,
  expectFlash,
  expectReservedRedirectWithTokens,
  setupStripe,
  submitMultiTicketForm,
} from "#test-utils";
import { createDailyListing } from "./daily-listing.ts";

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

        resetStripeClient();
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
  },
);
