// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { assertAdminHtml, testRequiresAuth } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { adminGet, setupListingAndLogin } from "#test-utils/session.ts";

// jscpd:ignore-end

describeWithEnv("server listings > log and activity", { db: true }, () => {
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
