// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { adminFormPost, setupListingAndLogin } from "#test-utils/session.ts";

// jscpd:ignore-end

describeWithEnv("server listings > edit post basics", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
  });

  describe("POST /admin/listing/:id/edit", () => {
    testRequiresAuth("/admin/listing/1/edit", {
      body: {
        max_attendees: "50",
        max_quantity: "1",
        name: "Updated Listing",
        slug: "updated-listing",
        thank_you_url: "https://example.com/updated",
      },
      multipart: true,
      setup: async () => {
        await createTestListing({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const { response } = await adminFormPost("/admin/listing/999/edit", {
        max_attendees: "50",
        max_quantity: "1",
        name: "Updated Listing",
        slug: "updated-listing",
        thank_you_url: "https://example.com/updated",
      });
      expect(response.status).toBe(404);
    });

    test("rejects request with invalid CSRF token", async () => {
      const { cookie } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await handleRequest(
        mockFormRequest(
          "/admin/listing/1/edit",
          {
            csrf_token: "invalid-token",
            max_attendees: "50",
            max_quantity: "1",
            name: "Updated Listing",
            slug: "updated-listing",
            thank_you_url: "https://example.com/updated",
          },
          cookie,
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("validates required fields", async () => {
      await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const { response } = await adminFormPost("/admin/listing/1/edit", {
        max_attendees: "50",
        max_quantity: "1",
        name: "",
        slug: "test-slug",
        thank_you_url: "https://example.com",
      });
      await expectHtmlResponse(response, 400, "Listing name is required");
    });

    test("updates listing when authenticated", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const { response } = await adminFormPost("/admin/listing/1/edit", {
        max_attendees: "200",
        max_quantity: "5",
        name: listing.name,
        slug: listing.slug,
        thank_you_url: "https://example.com/updated",
        unit_price: "20.00",
      });
      await expectFlashRedirect(
        "/admin/listing/1",
        "Listing updated",
      )(response);

      // Verify the listing was updated
      const updated = await getListingWithCount(1);
      expect(updated?.max_attendees).toBe(200);
      expect(updated?.thank_you_url).toBe("https://example.com/updated");
      expect(updated?.unit_price).toBe(2000);
    });

    test("updates listing running totals from the edit form", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/edit`,
        {
          booked_quantity: "12",
          max_attendees: "100",
          max_quantity: "1",
          name: listing.name,
          slug: listing.slug,
          thank_you_url: "https://example.com",
          tickets_count: "4",
        },
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}`,
        "Listing updated",
      )(response);

      // income is no longer a column override — it's projected from the ledger,
      // so the form only edits the count aggregates now.
      const updated = await getListingWithCount(listing.id);
      expect(updated?.attendee_count).toBe(12);
      expect(updated?.tickets_count).toBe(4);
    });

    test("rejects invalid listing running totals", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/edit`,
        {
          booked_quantity: "-1",
          max_attendees: "100",
          max_quantity: "1",
          name: listing.name,
          slug: listing.slug,
          thank_you_url: "https://example.com",
          tickets_count: "4",
        },
      );

      await expectHtmlResponse(
        response,
        400,
        "Total Attendees Ever must be 0 or greater",
      );
    });

    test("clears webhook URL when updating listing in demo mode", async () => {
      setDemoModeForTest(true);

      const { listing } = await setupListingAndLogin({
        maxAttendees: 100,
        webhookUrl: "https://example.com/original-webhook",
      });

      const { response } = await adminFormPost("/admin/listing/1/edit", {
        max_attendees: "200",
        max_quantity: "5",
        name: listing.name,
        slug: listing.slug,
        webhook_url: "https://example.com/new-webhook",
      });
      await expectFlashRedirect(
        "/admin/listing/1",
        "Listing updated",
      )(response);

      // Verify webhook_url was cleared
      const updated = await getListingWithCount(1);
      expect(updated?.webhook_url).toBe("");
    });
  });
});
