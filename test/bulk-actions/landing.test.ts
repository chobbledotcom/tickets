import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { listingsTable } from "#shared/db/listings.ts";
import {
  adminGet,
  createTestGroup,
  createTestListing,
  describeWithEnv,
  mockRequest,
} from "#test-utils";

describeWithEnv("Admin bulk actions landing page", { db: true }, () => {
  describe("GET /admin/groups/:id/bulk-actions", () => {
    test("renders the bulk-actions landing page with a duplicate link", async () => {
      const group = await createTestGroup({ name: "My Group" });
      await createTestListing({ groupId: group.id, name: "Listing A" });
      await createTestListing({ groupId: group.id, name: "Listing B" });

      const { response } = await adminGet(
        `/admin/groups/${group.id}/bulk-actions`,
      );
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("Bulk Actions");
      expect(html).toContain("Duplicate Group");
      expect(html).toContain(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
      );
      // Plural noun is used when the group has multiple listings.
      expect(html).toContain("all 2 listings");
    });

    test("uses singular 'listing' when the group has exactly one", async () => {
      const group = await createTestGroup({ name: "Solo Group" });
      await createTestListing({ groupId: group.id, name: "Only Listing" });

      const { response } = await adminGet(
        `/admin/groups/${group.id}/bulk-actions`,
      );
      const html = await response.text();

      expect(html).toContain("all 1 listing");
      // Guard against the plural-suffix "listings" slipping through
      expect(html).not.toContain("1 listings");
    });

    test("returns 404 for a non-existent group", async () => {
      const { response } = await adminGet("/admin/groups/999999/bulk-actions");
      expect(response.status).toBe(404);
    });

    test("redirects to login when unauthenticated", async () => {
      const response = await handleRequest(
        mockRequest("/admin/groups/1/bulk-actions"),
      );
      expect(response.status).toBe(302);
    });
  });

  describe("GET /admin/groups/:id/bulk-actions — conditional links", () => {
    /** Fetch the bulk-actions landing page for `group` and assert which of the
     *  deactivate/reactivate links it shows. Every test in this block follows
     *  the same GET-then-assert-on-action-links shape; this collapses the
     *  repeated `adminGet` + `toContain`/`not.toContain` scaffold. */
    const expectActionLinks = async (
      group: { id: number },
      visible: ("deactivate" | "reactivate")[],
    ): Promise<void> => {
      const { response } = await adminGet(
        `/admin/groups/${group.id}/bulk-actions`,
      );
      const html = await response.text();
      for (const action of ["deactivate", "reactivate"] as const) {
        const href = `/admin/groups/${group.id}/bulk-actions/${action}`;
        if (visible.includes(action)) {
          expect(html).toContain(href);
        } else {
          expect(html).not.toContain(href);
        }
      }
    };

    test("shows deactivate link and hides reactivate when all listings are active", async () => {
      const group = await createTestGroup({ name: "All Active" });
      await createTestListing({ groupId: group.id, name: "Active Listing" });

      await expectActionLinks(group, ["deactivate"]);
    });

    test("shows reactivate link and hides deactivate when all listings are deactivated", async () => {
      const group = await createTestGroup({ name: "All Off" });
      const listing = await createTestListing({
        groupId: group.id,
        name: "Off Listing",
      });
      await listingsTable.update(listing.id, { active: false });

      await expectActionLinks(group, ["reactivate"]);
    });

    test("shows only deactivate link when group is mixed (some active, some inactive)", async () => {
      const group = await createTestGroup({ name: "Mixed" });
      await createTestListing({ groupId: group.id, name: "Still Active" });
      const inactive = await createTestListing({
        groupId: group.id,
        name: "Gone",
      });
      await listingsTable.update(inactive.id, { active: false });

      await expectActionLinks(group, ["deactivate"]);
    });

    test("hides both deactivate and reactivate for an empty group", async () => {
      const group = await createTestGroup({ name: "Empty Group" });

      const { response } = await adminGet(
        `/admin/groups/${group.id}/bulk-actions`,
      );
      const html = await response.text();

      expect(html).not.toContain(
        `/admin/groups/${group.id}/bulk-actions/deactivate`,
      );
      expect(html).not.toContain(
        `/admin/groups/${group.id}/bulk-actions/reactivate`,
      );
    });
  });
});
