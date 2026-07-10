// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  expectHtmlResponse,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminGet } from "#test-utils/session.ts";

// jscpd:ignore-end
import { setupListingAndAttendee } from "./helpers.ts";

describeWithEnv(
  "server (admin attendees) > attendee detail",
  { db: true },
  () => {
    describe("GET /admin/attendees/:attendeeId", () => {
      testRequiresAuth("/admin/attendees/1", {
        setup: async () => {
          await setupListingAndAttendee();
        },
      });

      test("returns 404 for non-existent attendee", async () => {
        const response = await adminGet("/admin/attendees/999");
        expect(response.status).toBe(404);
      });

      // Regression: looking at one attendee wrongly rendered the Attendees
      // section's "Add" sub-nav (the page passed the section landing route as its
      // nav-active value, which re-opened the create sub-nav). A single-attendee
      // page must highlight the Attendees top-level link but show no "Add"
      // sub-nav beside it.
      test("the attendee page highlights Attendees but shows no Add sub-nav", async () => {
        const { attendee } = await setupListingAndAttendee();
        const response = await adminGet(`/admin/attendees/${attendee.id}`);
        const html = await response.text();
        expect(response.status).toBe(200);
        expect(html).toContain('class="active" href="/admin/attendees"');
        expect(html).not.toContain('href="/admin/attendees/new"');
        expect(html).not.toContain("admin-subnav");
      });

      test("shows edit form with prefilled attendee data", async () => {
        const listing = await createTestListing({ maxAttendees: 100 });
        const result = await bookAttendee(listing, {
          address: "123 Main St",
          email: "john@example.com",
          name: "John Doe",
          phone: "555-1234",
          quantity: 1,
          special_instructions: "VIP guest",
        });
        if (!result.success) throw new Error("Failed to create attendee");
        const attendee = result.attendees[0]!;

        const response = await adminGet(`/admin/attendees/${attendee.id}/edit`);
        await expectHtmlResponse(
          response,
          200,
          "Save Attendee",
          "John Doe",
          "john@example.com",
          "555-1234",
          "123 Main St",
          "VIP guest",
        );
      });

      test("includes return_url as hidden field when provided", async () => {
        const { attendee } = await setupListingAndAttendee();
        const response = await adminGet(
          `/admin/attendees/${attendee.id}/edit?return_url=${encodeURIComponent(
            "/admin/calendar#attendees",
          )}`,
        );
        await expectHtmlResponse(
          response,
          200,
          'name="return_url"',
          "/admin/calendar#attendees",
        );
      });

      test("shows current listing in registrations table", async () => {
        const { attendee } = await setupListingAndAttendee({
          listing: { maxAttendees: 100, name: "Current Listing" },
        });
        const response = await adminGet(`/admin/attendees/${attendee.id}/edit`);
        await expectHtmlResponse(
          response,
          200,
          "Current Listing",
          "Listing Registrations",
        );
      });

      test("edit page shows listing registrations and add-to-listing sections", async () => {
        const listing = await createTestListing({
          maxAttendees: 100,
          name: "Edit Page Listing",
        });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "Edit User",
          "edit@example.com",
        );
        const response = await adminGet(`/admin/attendees/${attendee.id}/edit`);
        const html = await expectHtmlResponse(
          response,
          200,
          "Listing Registrations",
          "Save Attendee",
        );
        // Listing link table shows the listing
        expect(html).toContain("Edit Page Listing");
        // The editor renders a quantity box per listing
        expect(html).toContain("qty_");
      });

      test("edit page shows checked-in badge for checked-in attendee", async () => {
        const listing = await createTestListing({
          maxAttendees: 100,
          name: "Checkin Badge Listing",
        });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "Badge User",
          "badge@example.com",
        );
        const { updateCheckedIn } = await import(
          "#shared/db/attendees/update.ts"
        );
        await updateCheckedIn(attendee.id, listing.id, true);
        const { invalidateListingsCache } = await import(
          "#shared/db/listings.ts"
        );
        invalidateListingsCache();
        const response = await adminGet(`/admin/attendees/${attendee.id}`);
        await expectHtmlResponse(response, 200, "Checked in");
      });

      test("edit page seeds the shared start date from a daily booking", async () => {
        const listing = await createTestListing({
          listingType: "daily",
          maxAttendees: 100,
          name: "Daily Dates Listing",
        });
        const result = await bookAttendee(listing, {
          date: "2026-04-07",
          email: "daily@example.com",
          name: "Daily User",
        });
        if (!result.success) throw new Error("Failed");
        const attendeeId = result.attendees[0]!.id;
        const response = await adminGet(`/admin/attendees/${attendeeId}/edit`);
        const html = await expectHtmlResponse(
          response,
          200,
          "Daily Dates Listing",
        );
        // The shared start date is seeded from the daily booking.
        expect(html).toContain('value="2026-04-07"');
      });

      test("includes active listings in add-to-listing selector", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 100,
          name: "Listing 1",
        });
        await createTestListing({
          active: true,
          maxAttendees: 100,
          name: "Listing 2",
        });
        const attendee = await createTestAttendee(
          listing1.id,
          listing1.slug,
          "John Doe",
          "john@example.com",
        );
        const response = await adminGet(`/admin/attendees/${attendee.id}/edit`);
        await expectHtmlResponse(response, 200, "Listing 1", "Listing 2");
      });
    });
  },
);
