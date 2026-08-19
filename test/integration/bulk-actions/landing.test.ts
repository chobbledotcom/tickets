import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { listingsTable } from "#db/listings/records.ts";
import { handleRequest } from "#routes";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { adminGet } from "#test-utils/session.ts";

describeWithEnv("Admin bulk actions landing page", { db: true }, () => {
  describe("GET /admin/groups/:id/bulk-actions", () => {
    test("returns 404 for a non-existent group", async () => {
      // Not-found boundary — a story cannot reach this path (it sets up a
      // real group first), so it stays as a direct technical contract.
      const response = await adminGet("/admin/groups/999999/bulk-actions");
      expect(response.status).toBe(404);
    });

    test("redirects to login when unauthenticated", async () => {
      const response = await handleRequest(
        mockRequest("/admin/groups/1/bulk-actions"),
      );
      expect(response.status).toBe(302);
    });
  });

  describe("GET /admin/groups/:id/bulk-actions — rendered branches", () => {
    /** Fetch the landing page for `group` and assert which of the
     *  deactivate/reactivate links its HTML carries, plus the rendered
     *  member-count phrase. The story `catalogue.choosing-a-bulk-action-for-
     *  a-group` states these rules in the organiser's terms; these pins own
     *  the direct coverage of the template's `hasActive`/`allDeactivated`
     *  branches and the count copy, which a Cucumber journey may never be
     *  the only cover of. */
    const expectLandingRender = async (
      group: { id: number },
      visible: ("deactivate" | "reactivate")[],
      countPhrase: string,
    ): Promise<string> => {
      const response = await adminGet(`/admin/groups/${group.id}/bulk-actions`);
      const html = await response.text();
      expect(response.status).toBe(200);
      for (const action of ["deactivate", "reactivate"] as const) {
        const href = `/admin/groups/${group.id}/bulk-actions/${action}`;
        if (visible.includes(action)) {
          expect(html).toContain(href);
        } else {
          expect(html).not.toContain(href);
        }
      }
      expect(html).toContain(countPhrase);
      return html;
    };

    test("a mixed group renders the deactivate link, no reactivate link, and the plural count", async () => {
      const group = await createTestGroup({ name: "Mixed Pin" });
      await createTestListing({ groupId: group.id, name: "Still Active" });
      const inactive = await createTestListing({
        groupId: group.id,
        name: "Gone",
      });
      await listingsTable.update(inactive.id, { active: false });

      const html = await expectLandingRender(
        group,
        ["deactivate"],
        "all 2 listings",
      );
      // The copy action is offered unconditionally on the success render.
      expect(html).toContain(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
      );
    });

    test("an all-deactivated group renders the reactivate link and the singular count", async () => {
      const group = await createTestGroup({ name: "All Off Pin" });
      const listing = await createTestListing({
        groupId: group.id,
        name: "Off Listing",
      });
      await listingsTable.update(listing.id, { active: false });

      const html = await expectLandingRender(
        group,
        ["reactivate"],
        "all 1 listing",
      );
      // Guard against the plural-suffix "listings" slipping through for 1.
      expect(html).not.toContain("1 listings");
    });

    test("an empty group renders neither the deactivate nor the reactivate link", async () => {
      const group = await createTestGroup({ name: "Empty Pin" });
      await expectLandingRender(group, [], "all 0 listings");
    });
  });
});
