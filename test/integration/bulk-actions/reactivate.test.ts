import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  getListingWithCount,
  listingsTable,
} from "#shared/db/listings/records.ts";
import { expectHtml } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

describeWithEnv("Admin bulk actions — reactivate", { db: true }, () => {
  const createInactiveListGroup = async (name: string) => {
    const group = await createTestGroup({ name });
    const a = await createTestListing({ groupId: group.id, name: "A" });
    const b = await createTestListing({ groupId: group.id, name: "B" });
    await listingsTable.update(a.id, { active: false });
    await listingsTable.update(b.id, { active: false });
    return { a, b, group };
  };

  describe("GET /admin/groups/:id/bulk-actions/reactivate", () => {
    test("renders the reactivate confirmation form with a singular listing count", async () => {
      const group = await createTestGroup({ name: "Solo Off" });
      const listing = await createTestListing({
        groupId: group.id,
        name: "Only",
      });
      await listingsTable.update(listing.id, { active: false });

      await expectHtml(
        await adminGet(`/admin/groups/${group.id}/bulk-actions/reactivate`),
        {
          contains: [
            "Reactivate Group",
            'name="confirm_identifier"',
            "reactivate 1 listing",
          ],
          notContains: ["reactivate 1 listings"],
          status: 200,
        },
      );
    });

    test("renders the reactivate form with a plural listing count", async () => {
      const { group } = await createInactiveListGroup("Many Off");

      await expectHtml(
        await adminGet(`/admin/groups/${group.id}/bulk-actions/reactivate`),
        { contains: ["reactivate 2 listings"], status: 200 },
      );
    });

    test("returns 404 when the group does not exist", async () => {
      // Not-found boundary — a story cannot reach this path (it sets up a
      // real group first), so it stays as a direct technical contract.
      const response = await adminGet(
        "/admin/groups/999999/bulk-actions/reactivate",
      );
      expect(response.status).toBe(404);
    });
  });

  describe("POST /admin/groups/:id/bulk-actions/reactivate", () => {
    test("reactivates every listing in the group when the name is confirmed", async () => {
      // Pins the reactivate success branch for the coverage gate: the toggle
      // skips the deactivation-only orphan guard, `setGroupListingsActive`
      // runs with active = true, and every member comes back. The story
      // `@case:catalogue.reactivate-confirms-and-brings-every-member-back`
      // states the same rule in the organiser's terms.
      const { group, a, b } = await createInactiveListGroup("Bring Back");

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/reactivate`,
        { confirm_identifier: "Bring Back" },
      );

      expect(response.status).toBe(302);
      expect((await getListingWithCount(a.id))?.active).toBe(true);
      expect((await getListingWithCount(b.id))?.active).toBe(true);
    });

    test("rejects when the group name does not match and leaves listings inactive", async () => {
      // Pins the shared group-toggle mismatch redirect for the coverage gate —
      // the deactivate twin of this test was replaced by its story, so this is
      // the one direct cover of that branch for both directions. The story
      // `@case:catalogue.reactivate-refuses-with-a-wrong-name` states the
      // same rule in the organiser's terms.
      const group = await createTestGroup({ name: "Stay Off" });
      const listing = await createTestListing({
        groupId: group.id,
        name: "Listing",
      });
      await listingsTable.update(listing.id, { active: false });

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/reactivate`,
        { confirm_identifier: "Different" },
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(
        `/admin/groups/${group.id}/bulk-actions/reactivate`,
      );
      expect((await getListingWithCount(listing.id))?.active).toBe(false);
    });
  });
});
