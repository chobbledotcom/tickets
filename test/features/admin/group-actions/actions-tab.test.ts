import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { listingsTable } from "#db/listings/records.ts";
import { handleRequest } from "#routes";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { adminGet } from "#test-utils/session.ts";

describeWithEnv("the group Actions tab", { db: true }, () => {
  describe("GET /admin/groups/:id/actions", () => {
    test("returns 404 for a non-existent group", async () => {
      // Not-found boundary — a story cannot reach this path (it sets up a
      // real group first), so it stays as a direct technical contract.
      const response = await adminGet("/admin/groups/999999/actions");
      expect(response.status).toBe(404);
    });

    test("redirects to login when unauthenticated", async () => {
      const response = await handleRequest(
        mockRequest("/admin/groups/1/actions"),
      );
      expect(response.status).toBe(302);
    });
  });

  describe("GET /admin/groups/:id/actions — the sale switch", () => {
    /** Fetch the Actions tab for `group` and assert which of the
     *  deactivate/reactivate links it carries. The story `catalogue.
     *  choosing-a-bulk-action-for-a-group` states these rules in the
     *  organiser's terms; these pins own the direct coverage of the
     *  active/listings predicates, which a Cucumber journey may never be the
     *  only cover of. */
    const expectActionsRender = async (
      group: { id: number },
      visible: ("deactivate" | "reactivate")[],
    ): Promise<string> => {
      const response = await adminGet(`/admin/groups/${group.id}/actions`);
      const html = await response.text();
      expect(response.status).toBe(200);
      // The copy is offered for every group, whatever its listings do.
      assertStringIncludes(html, `href="/admin/groups/${group.id}/duplicate"`);
      for (const action of ["deactivate", "reactivate"] as const) {
        const href = `/admin/groups/${group.id}/${action}`;
        if (visible.includes(action)) {
          assertStringIncludes(html, href);
        } else {
          assert(!html.includes(href));
        }
      }
      return html;
    };

    test("a mixed group offers deactivate and not reactivate", async () => {
      const group = await createTestGroup({ name: "Mixed Pin" });
      await createTestListing({ groupId: group.id, name: "Still Active" });
      const inactive = await createTestListing({
        groupId: group.id,
        name: "Gone",
      });
      await listingsTable.update(inactive.id, { active: false });

      const html = await expectActionsRender(group, ["deactivate"]);
      // Each entry spells out what the action does, so the link is not the
      // only explanation of it.
      assertStringIncludes(
        html,
        "Deactivate every active listing in this group.",
      );
      assert(!html.includes("Reactivate every listing in this group."));
    });

    test("an all-deactivated group offers reactivate and not deactivate", async () => {
      const group = await createTestGroup({ name: "All Off Pin" });
      const listing = await createTestListing({
        groupId: group.id,
        name: "Off Listing",
      });
      await listingsTable.update(listing.id, { active: false });

      const html = await expectActionsRender(group, ["reactivate"]);
      assertStringIncludes(html, "Reactivate every listing in this group.");
      assert(!html.includes("Deactivate every active listing in this group."));
    });

    test("an empty group offers neither sale switch", async () => {
      const group = await createTestGroup({ name: "Empty Pin" });
      await expectActionsRender(group, []);
    });
  });
});
