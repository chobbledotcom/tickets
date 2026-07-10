// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { logActivity } from "#test-utils/activity-log.ts";
import {
  assertAdminHtml,
  assertAdminHtmlWithCookie,
  expectHtmlResponse,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  adminGet,
  createTestManagerSession,
  setupListingAndLogin,
} from "#test-utils/session.ts";

// jscpd:ignore-end

describeWithEnv("server listings > log and activity", { db: true }, () => {
  describe("GET /admin/log", () => {
    testRequiresAuth("/admin/log");

    test("shows log page when authenticated", async () => {
      // Create an listing to generate activity
      await createTestListing({
        maxAttendees: 50,
        name: "Log Test",
      });

      const response = await adminGet("/admin/log");
      await expectHtmlResponse(response, 200, "Log");
    });

    test("shows log page for manager", async () => {
      const managerCookie = await createTestManagerSession();
      await assertAdminHtmlWithCookie("/admin/log", managerCookie, "Log");
    });

    test("shows truncation message when more than 200 entries", async () => {
      // Create 201 log entries to trigger truncation
      for (let i = 0; i < 201; i++) {
        await logActivity(`Action ${i}`);
      }

      const response = await adminGet("/admin/log");
      const html = await response.text();
      expect(html).toContain("Showing the most recent 200 entries");
    });

    test("links each entry to its attendee and listing by name", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        maxAttendees: 50,
        name: "Gala Dinner",
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Ada Lovelace",
        "ada@example.com",
      );
      await logActivity("Balance updated", listing.id, attendee.id);

      const response = await awaitTestRequest("/admin/log", { cookie });
      const html = await response.text();
      expect(html).toContain(
        `<a href="/admin/attendees/${attendee.id}">Ada Lovelace</a>`,
      );
      expect(html).toContain(
        `<a href="/admin/listing/${listing.id}">Gala Dinner</a>`,
      );
    });
  });
  describe("GET /admin/listing/:id/activity", () => {
    testRequiresAuth("/admin/listing/1/activity");

    test("returns 404 for non-existent listing", async () => {
      const response = await adminGet("/admin/listing/999/activity");
      expect(response.status).toBe(404);
    });

    test("shows log for existing listing", async () => {
      const { listing } = await setupListingAndLogin({
        maxAttendees: 50,
        name: "Listing Log",
      });

      await assertAdminHtml(
        `/admin/listing/${listing.id}/activity`,
        "Log",
        listing.name,
      );
    });
  });
});
