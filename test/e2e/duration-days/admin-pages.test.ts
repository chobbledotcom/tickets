import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import {
  expectFlashRedirect,
  expectListingActivityLogLacks,
} from "#test-utils/assertions.ts";
import { describeWithEnv, rawListingRange } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createDailyTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { adminFormPost, setupListingAndLogin } from "#test-utils/session.ts";

describeWithEnv("e2e: multi-day bookings — admin pages", { db: true }, () => {
  describe("public ticket page", () => {
    test("shows booking duration hint for multi-day daily listings", async () => {
      const { buildTicketListing } = await import("#shared/booking/model.ts");
      const { ticketPage } = await import(
        "#templates/public/reservations/ticket-page.tsx"
      );
      const listing = await createDailyTestListing({
        durationDays: 3,
        maxAttendees: 10,
      });
      const fresh = (await getListingWithCount(listing.id))!;
      const html = ticketPage({
        dates: ["2026-08-10", "2026-08-11"],
        listings: [buildTicketListing(fresh, false, undefined)],
        slugs: [listing.slug],
      });
      expect(html).toContain("each booking reserves 3 days");
    });

    test("no duration hint for single-day daily listings", async () => {
      const { buildTicketListing } = await import("#shared/booking/model.ts");
      const { ticketPage } = await import(
        "#templates/public/reservations/ticket-page.tsx"
      );
      const listing = await createDailyTestListing({ maxAttendees: 10 });
      const fresh = (await getListingWithCount(listing.id))!;
      const html = ticketPage({
        dates: ["2026-08-10"],
        listings: [buildTicketListing(fresh, false, undefined)],
        slugs: [listing.slug],
      });
      expect(html).not.toContain("each booking reserves");
    });
  });

  describe("admin listing detail page", () => {
    test("shows booking duration row for daily listings with duration > 1", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        durationDays: 3,
        listingType: "daily",
        maximumDaysAfter: 30,
        minimumDaysBefore: 0,
      });
      const response = await awaitTestRequest(`/admin/listing/${listing.id}`, {
        cookie,
      });
      const html = await response.text();
      expect(html).toContain("Booking Duration");
      expect(html).toContain("3 day(s)");
    });

    test("does not show booking duration for standard listings", async () => {
      const { listing, cookie } = await setupListingAndLogin();
      const response = await awaitTestRequest(`/admin/listing/${listing.id}`, {
        cookie,
      });
      const html = await response.text();
      expect(html).not.toContain("Booking Duration");
    });
  });

  describe("admin listing edit page", () => {
    test("edit form pre-fills duration_days and includes warning UI", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        durationDays: 5,
        listingType: "daily",
        maximumDaysAfter: 30,
        minimumDaysBefore: 0,
      });
      const response = await awaitTestRequest(
        `/admin/listing/${listing.id}/edit`,
        {
          cookie,
        },
      );
      const html = await response.text();
      // The duration input is pre-filled with the stored value.
      expect(html).toMatch(/name="duration_days"[^>]*value="5"/);
      // Every element initDurationWarning() hooks into must be present —
      // if any of these IDs change, the client-side gate silently no-ops.
      expect(html).toContain('id="listing-edit-form"');
      expect(html).toContain('id="duration-warning"');
      expect(html).toContain('data-duration-original="5"');
      expect(html).toContain('id="duration-warning-confirm"');
      expect(html).toContain('id="listing-edit-submit"');
    });
  });

  describe("admin listing edit POST", () => {
    /** Minimal valid edit form for a daily listing (urlencoded POST). */
    const dailyEditForm = (
      listing: { name: string; slug: string },
      durationDays: number,
      groupId = 0,
    ): Record<string, string> => ({
      duration_days: String(durationDays),
      // Membership is carried by the group_ids checkboxes; only send one when the
      // listing is in a group (0 = ungrouped).
      ...(groupId > 0 ? { group_ids: String(groupId) } : {}),
      listing_type: "daily",
      max_attendees: "100",
      max_quantity: "1",
      name: listing.name,
      slug: listing.slug,
      thank_you_url: "https://example.com",
    });

    test("editing a daily listing without changing duration leaves ranges and log alone", async () => {
      const listing = await createDailyTestListing({
        durationDays: 2,
        maxAttendees: 10,
        maximumDaysAfter: 60,
      });
      await bookAttendee(listing, { date: "2026-09-10", durationDays: 2 });
      const before = await rawListingRange(listing.id);

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/edit`,
        dailyEditForm(listing, 2),
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}`,
        "Listing updated",
      )(response);

      const after = await rawListingRange(listing.id);
      expect(after!.end_at).toBe(before!.end_at);
      await expectListingActivityLogLacks(listing.id, "duration changed");
    });

    test("changing duration on a standard listing does not reconcile or log a duration change", async () => {
      const { listing } = await setupListingAndLogin({ maxAttendees: 100 });

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/edit`,
        {
          duration_days: "7",
          max_attendees: "100",
          max_quantity: "1",
          name: listing.name,
          slug: listing.slug,
          thank_you_url: "https://example.com",
        },
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}`,
        "Listing updated",
      )(response);

      // The value persists (inert until the listing becomes daily)…
      expect((await getListingWithCount(listing.id))?.duration_days).toBe(7);
      // …but no reconciliation activity is logged for a standard listing.
      await expectListingActivityLogLacks(listing.id, "duration changed");
    });
  });
});
