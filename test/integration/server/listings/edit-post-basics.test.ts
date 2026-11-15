import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { getListingWithCount } from "#db/listings/records.ts";
import { handleRequest } from "#routes";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { baseListingForm } from "#test-utils/factories.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";
import {
  submitListingEdit,
  submitOwnListingEdit,
} from "#test-utils/listing-submits.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { setupListingAndLogin } from "#test-utils/session.ts";

/** The boxes of an edit that renames nothing and moves to a new slug. */
const UPDATED_BOXES = {
  name: "Updated Listing",
  slug: "updated-listing",
  thank_you_url: "https://example.com/updated",
};

const LISTING_SETUP = { maxAttendees: 100, thankYouUrl: "https://example.com" };

/** Save the signed-in owner's first listing under its own name and slug, plus
 *  the given boxes. */
const saveFirstListing = async (boxes: TestFormValues) => {
  const { listing } = await setupListingAndLogin(LISTING_SETUP);
  const { response } = await submitOwnListingEdit(listing, boxes);
  return { response, updated: await getListingWithCount(listing.id) };
};

describeWithEnv("server listings > edit post basics", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
  });

  describe("POST /admin/listing/:id/edit", () => {
    testRequiresAuth("/admin/listing/1/edit", {
      body: { ...baseListingForm, ...UPDATED_BOXES },
      multipart: true,
      setup: async () => {
        await createTestListing(LISTING_SETUP);
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const { response } = await submitListingEdit(999, UPDATED_BOXES);
      expect(response.status).toBe(404);
    });

    test("rejects request with invalid CSRF token", async () => {
      const { cookie } = await setupListingAndLogin(LISTING_SETUP);

      const response = await handleRequest(
        mockFormRequest(
          "/admin/listing/1/edit",
          { ...baseListingForm, ...UPDATED_BOXES, csrf_token: "invalid-token" },
          cookie,
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("validates required fields", async () => {
      const { response } = await saveFirstListing({ name: "" });
      await expectHtmlResponse(response, 400, "Listing name is required");
    });

    test("updates listing when authenticated", async () => {
      const { response, updated } = await saveFirstListing({
        max_attendees: "200",
        max_quantity: "5",
        thank_you_url: "https://example.com/updated",
        unit_price: "20.00",
      });
      await expectFlashRedirect(
        "/admin/listing/1",
        "Listing updated",
      )(response);
      expect([
        updated?.max_attendees,
        updated?.thank_you_url,
        updated?.unit_price,
      ]).toEqual([200, "https://example.com/updated", 2000]);
    });

    test("updates listing running totals from the edit form", async () => {
      const { response, updated } = await saveFirstListing({
        booked_quantity: "12",
        tickets_count: "4",
      });
      expect(response.status).toBe(302);
      // income is no longer a column override — it's projected from the ledger,
      // so the form only edits the count aggregates now.
      expect([updated?.attendee_count, updated?.tickets_count]).toEqual([
        12, 4,
      ]);
    });

    test("rejects invalid listing running totals", async () => {
      const { response } = await saveFirstListing({
        booked_quantity: "-1",
        tickets_count: "4",
      });
      await expectHtmlResponse(
        response,
        400,
        "Total attendees ever must be 0 or greater",
      );
    });

    test("refuses a webhook URL when updating listing in demo mode", async () => {
      setDemoModeForTest(true);
      const { response, updated } = await saveFirstListing({
        max_attendees: "200",
        webhook_url: "https://example.com/new-webhook",
      });
      expect([response.status, updated?.max_attendees]).toEqual([400, 100]);
    });
  });
});
