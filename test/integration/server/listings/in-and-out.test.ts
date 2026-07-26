// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { assertAdminHtml, testRequiresAuth } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  adminGet,
  setupListingAndLogin,
} from "#test-utils/session.ts";

// jscpd:ignore-end

describeWithEnv("server listings > check-in filter", { db: true }, () => {
  /** Creates a listing with one checked-in and one checked-out attendee —
   *  the shared fixture behind the /in and /out filter tests below. */
  const setupListingWithCheckedInAndOutAttendees = async () => {
    const { listing, cookie } = await setupListingAndLogin({
      maxAttendees: 100,
      thankYouUrl: "https://example.com",
    });
    const checkedInAttendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "Checked In User",
      "in@example.com",
    );
    await createTestAttendee(
      listing.id,
      listing.slug,
      "Not Checked User",
      "out@example.com",
    );

    // Check in the first attendee
    await adminFormPost(
      `/admin/listing/${listing.id}/attendee/${checkedInAttendee.id}/checkin`,
      {},
    );

    return { cookie, listing };
  };

  describe("GET /admin/listing/:id/in", () => {
    testRequiresAuth("/admin/listing/1/in", {
      setup: async () => {
        await createTestListing({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await adminGet("/admin/listing/999/in");
      expect(response.status).toBe(404);
    });

    test("shows only checked-in attendees", async () => {
      const { listing } = await setupListingWithCheckedInAndOutAttendees();

      const html = await assertAdminHtml(
        `/admin/listing/${listing.id}/attendees?filter=in`,
        "Checked In User",
        "<strong>Checked In</strong>",
      );
      expect(html).not.toContain("Not Checked User");
    });
  });
  describe("GET /admin/listing/:id/out", () => {
    testRequiresAuth("/admin/listing/1/out", {
      setup: async () => {
        await createTestListing({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await adminGet("/admin/listing/999/out");
      expect(response.status).toBe(404);
    });

    test("shows only checked-out attendees", async () => {
      const { listing, cookie } =
        await setupListingWithCheckedInAndOutAttendees();

      const response = await awaitTestRequest(
        `/admin/listing/${listing.id}/attendees?filter=out`,
        {
          cookie: cookie,
        },
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("Checked In User");
      expect(html).toContain("Not Checked User");
      expect(html).toContain("<strong>Checked Out</strong>");
    });
  });
});
