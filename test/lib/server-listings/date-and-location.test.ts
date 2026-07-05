// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getListingWithCount } from "#shared/db/listings.ts";
import {
  adminFormPost,
  assertAdminHtml,
  awaitTestRequest,
  createTestAttendee,
  createTestListing,
  describeWithEnv,
  expectHtmlResponse,
  setupListingAndLogin,
  updateTestListing,
} from "#test-utils";

// jscpd:ignore-end

describeWithEnv("server listings > date and location", { db: true }, () => {
  describe("listing date and location", () => {
    test("creates listing with date and location", async () => {
      const listing = await createTestListing({
        date: "2026-06-15T14:00",
        location: "Village Hall",
      });
      const saved = await getListingWithCount(listing.id);
      expect(saved?.date).toBe("2026-06-15T14:00:00.000Z");
      expect(saved?.location).toBe("Village Hall");
    });

    test("updates listing date and location", async () => {
      const listing = await createTestListing();
      await updateTestListing(listing.id, {
        date: "2026-12-25T18:00",
        location: "Town Centre",
      });
      const updated = await getListingWithCount(listing.id);
      expect(updated?.date).toBe("2026-12-25T18:00:00.000Z");
      expect(updated?.location).toBe("Town Centre");
    });

    test("clears listing date by setting to empty string", async () => {
      const listing = await createTestListing({ date: "2026-06-15T14:00" });
      await updateTestListing(listing.id, { date: "" });
      const updated = await getListingWithCount(listing.id);
      expect(updated?.date).toBe("");
    });

    test("admin detail page shows Listing Date and Location when set", async () => {
      const { listing } = await setupListingAndLogin({
        date: "2026-06-15T14:00",
        location: "Village Hall",
      });
      await assertAdminHtml(
        `/admin/listing/${listing.id}`,
        "Listing Date",
        "Monday 15 June 2026 at 14:00 UTC",
        "<th>Location</th>",
        "Village Hall",
      );
    });

    test("admin detail page hides Listing Date and Location when empty", async () => {
      const { listing } = await setupListingAndLogin();
      const html = await assertAdminHtml(`/admin/listing/${listing.id}`);
      expect(html).not.toContain("Listing Date");
      expect(html).not.toContain("<th>Location</th>");
    });

    test("admin edit page pre-fills date as split inputs", async () => {
      const { listing } = await setupListingAndLogin({
        date: "2026-06-15T14:00",
      });
      await assertAdminHtml(
        `/admin/listing/${listing.id}/edit`,
        'value="2026-06-15"',
        'value="14:00"',
      );
    });

    test("admin edit page pre-fills location", async () => {
      const { listing } = await setupListingAndLogin({
        location: "Village Hall",
      });
      await assertAdminHtml(
        `/admin/listing/${listing.id}/edit`,
        'value="Village Hall"',
      );
    });

    test("CSV export includes Listing Date and Listing Location columns", async () => {
      const { listing } = await setupListingAndLogin({
        date: "2026-06-15T14:00",
        location: "Village Hall",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Alice",
        "alice@test.com",
      );
      await assertAdminHtml(
        `/admin/listing/${listing.id}/export`,
        "Listing Date",
        "Listing Location",
        "Village Hall",
      );
    });

    test("CSV export omits Listing Date and Listing Location when empty", async () => {
      const { listing, cookie } = await setupListingAndLogin();
      await createTestAttendee(listing.id, listing.slug, "Bob", "bob@test.com");
      const response = await awaitTestRequest(
        `/admin/listing/${listing.id}/export`,
        { cookie },
      );
      expect(response.status).toBe(200);
      const csv = await response.text();
      expect(csv).not.toContain("Listing Date");
      expect(csv).not.toContain("Listing Location");
    });

    test("rejects invalid listing date on edit", async () => {
      const { listing } = await setupListingAndLogin();
      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/edit`,
        {
          date_date: "not-a-date",
          date_time: "99:99",
          max_attendees: "100",
          max_quantity: "1",
          name: listing.name,
          slug: listing.slug,
        },
      );
      await expectHtmlResponse(
        response,
        400,
        "Please enter a valid date and time",
      );
    });
  });
});
