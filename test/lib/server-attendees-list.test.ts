import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ATTENDEES_PAGE_SIZE } from "#routes/admin/attendees-list.ts";
import {
  adminGet,
  assertAdminHtml,
  createTestAttendeeDirect,
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
  testRequiresAuth,
} from "#test-utils";

/** Create a standard listing with plenty of capacity */
const makeListing = (name: string, maxAttendees = 100) =>
  createTestListing({
    maxAttendees,
    name,
    thankYouUrl: "https://example.com",
  });

describeWithEnv("server (admin attendees list)", { db: true }, () => {
  describe("GET /admin/attendees", () => {
    testRequiresAuth("/admin/attendees");

    test("renders the attendees page with the registration", async () => {
      const listing = await makeListing("Gala Night");
      await createTestAttendeeDirect(listing.id, "Alice", "alice@example.com");

      await assertAdminHtml(
        "/admin/attendees",
        "<h1>Attendees</h1>",
        "Alice",
        "Gala Night",
      );
    });

    test("lists the newest registration first by default", async () => {
      const listing = await makeListing("Gala Night");
      await createTestAttendeeDirect(listing.id, "Alice", "alice@example.com");
      await createTestAttendeeDirect(listing.id, "Bob", "bob@example.com");

      const { response } = await adminGet("/admin/attendees");
      const html = await response.text();
      // Bob registered last, so appears above Alice.
      expect(html.indexOf("Bob")).toBeLessThan(html.indexOf("Alice"));
    });

    test("lists the oldest registration first when sort=oldest", async () => {
      const listing = await makeListing("Gala Night");
      await createTestAttendeeDirect(listing.id, "Alice", "alice@example.com");
      await createTestAttendeeDirect(listing.id, "Bob", "bob@example.com");

      const { response } = await adminGet("/admin/attendees?sort=oldest");
      const html = await response.text();
      expect(html.indexOf("Alice")).toBeLessThan(html.indexOf("Bob"));
    });

    test("filters the table to a single listing", async () => {
      const first = await makeListing("First Listing");
      const second = await makeListing("Second Listing");
      await createTestAttendeeDirect(first.id, "AliceOne", "a1@example.com");
      await createTestAttendeeDirect(second.id, "BobTwo", "b2@example.com");

      const { response } = await adminGet(
        `/admin/attendees?listing=${first.id}`,
      );
      const html = await response.text();
      expect(html).toContain("AliceOne");
      expect(html).not.toContain("BobTwo");
      // The chosen listing stays selected in the filter dropdown.
      expect(html).toContain(`selected value="${first.id}"`);
    });

    test("falls back to all listings for an unknown listing filter", async () => {
      const first = await makeListing("First Listing");
      const second = await makeListing("Second Listing");
      await createTestAttendeeDirect(first.id, "AliceOne", "a1@example.com");
      await createTestAttendeeDirect(second.id, "BobTwo", "b2@example.com");

      const { response } = await adminGet("/admin/attendees?listing=999999");
      const html = await response.text();
      expect(html).toContain("AliceOne");
      expect(html).toContain("BobTwo");
    });

    test("flags a deactivated listing in the filter dropdown", async () => {
      const listing = await makeListing("Retired Show");
      await deactivateTestListing(listing.id);

      await assertAdminHtml("/admin/attendees", "Retired Show (deactivated)");
    });

    test("shows an empty state when no attendees exist", async () => {
      await makeListing("Empty Listing");

      await assertAdminHtml("/admin/attendees", "No attendees yet");
    });

    test("clamps a non-positive page number to the first page", async () => {
      const listing = await makeListing("Gala Night");
      await createTestAttendeeDirect(listing.id, "Alice", "alice@example.com");

      const { response } = await adminGet("/admin/attendees?page=0");
      const html = await response.text();
      expect(html).toContain("Alice");
      // First page has no previous link.
      expect(html).not.toContain('rel="prev"');
    });

    test("paginates results at the page size", async () => {
      const listing = await makeListing("Big Listing", ATTENDEES_PAGE_SIZE * 2);
      // Oldest registration is created first, so it lands on the second page.
      await createTestAttendeeDirect(
        listing.id,
        "OldestPerson",
        "oldest@example.com",
      );
      for (let i = 0; i < ATTENDEES_PAGE_SIZE; i++) {
        await createTestAttendeeDirect(
          listing.id,
          `Filler ${i}`,
          `filler${i}@example.com`,
        );
      }

      // Page 0: newest PAGE_SIZE rows, a next link, no previous link.
      const first = await adminGet("/admin/attendees");
      const firstHtml = await first.response.text();
      expect(firstHtml).not.toContain("OldestPerson");
      expect(firstHtml).toContain('rel="next"');
      expect(firstHtml).toContain('href="/admin/attendees?page=1"');
      expect(firstHtml).not.toContain('rel="prev"');

      // Page 1: the remaining oldest row, a previous link, no next link.
      const second = await adminGet("/admin/attendees?page=1");
      const secondHtml = await second.response.text();
      expect(secondHtml).toContain("OldestPerson");
      expect(secondHtml).toContain('rel="prev"');
      expect(secondHtml).not.toContain('rel="next"');
    });
  });
});
