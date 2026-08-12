import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { optInAddOnForListings } from "#test-utils/modifiers.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

describeWithEnv("Admin bulk actions — deactivate", { db: true }, () => {
  describe("GET /admin/groups/:id/bulk-actions/deactivate", () => {
    test("returns 404 when the group does not exist", async () => {
      // Not-found boundary — a story cannot reach this path (it sets up a
      // real group first), so it stays as a direct technical contract.
      const response = await adminGet(
        "/admin/groups/999999/bulk-actions/deactivate",
      );
      expect(response.status).toBe(404);
    });

    test("renders the confirmation form with singular listing count", async () => {
      // Sits beside the Cucumber story `catalogue.taking-a-group-off-sale`,
      // which opens the form and submits it. The story reads fields by name,
      // so a regression that stopped rendering the impact count (while the
      // form fields still sent) would pass the story. This GET test pins the
      // route's duty to render the singular count copy.
      const group = await createTestGroup({ name: "Solo Deact" });
      await createTestListing({ groupId: group.id, name: "Only" });

      const html = await adminGet(
        `/admin/groups/${group.id}/bulk-actions/deactivate`,
      ).then((r) => r.text());

      expect(html).toContain("deactivate 1 active listing");
      expect(html).not.toContain("deactivate 1 active listings");
    });

    test("renders the confirmation form with plural listing count", async () => {
      const group = await createTestGroup({ name: "Multi Deact" });
      await createTestListing({ groupId: group.id, name: "A" });
      await createTestListing({ groupId: group.id, name: "B" });

      const html = await adminGet(
        `/admin/groups/${group.id}/bulk-actions/deactivate`,
      ).then((r) => r.text());

      expect(html).toContain("deactivate 2 active listings");
    });
  });

  describe("POST /admin/groups/:id/bulk-actions/deactivate", () => {
    test("deactivates every listing in the group and redirects to the group page on success", async () => {
      // Sits beside the Cucumber story `catalogue.taking-a-group-off-sale`.
      // The story proves the actor-facing claims, but story execution is kept
      // out of the direct suite's coverage gate. This direct test pins the
      // success branch: `setGroupListingsActive(..., false)` runs and the
      // 302 redirect to the group page is returned.
      const group = await createTestGroup({ name: "Shutdown" });
      const a = await createTestListing({ groupId: group.id, name: "A" });
      const b = await createTestListing({ groupId: group.id, name: "B" });

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/deactivate`,
        { confirm_identifier: "Shutdown" },
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(
        `/admin/groups/${group.id}`,
      );
      expect((await getListingWithCount(a.id))?.active).toBe(false);
      expect((await getListingWithCount(b.id))?.active).toBe(false);
    });

    test("rejects deactivating a group that holds the only rescuing page of a child add-on, leaving every listing active", async () => {
      // Sits beside the Cucumber story `catalogue.taking-a-group-off-sale`.
      // The story proves the actor-facing claims (confirms by name, refuses a
      // wrong name, leaves other groups alone). This direct test pins the
      // orphan-prevention guard: a {child, rescuingPage}-scoped opt-in add-on
      // is reachable only via `rescuingPage`, which lives in the group, so a
      // bulk deactivate would orphan the add-on. The shared guard must block
      // the whole batch before any UPDATE — a branch the story's form-driven
      // path does not exercise because it sets up no add-on relationship.
      const group = await createTestGroup({ name: "Rescue Group" });
      const rescuingPage = await createTestListing({
        groupId: group.id,
        name: "Rescuing page",
      });
      const sibling = await createTestListing({
        groupId: group.id,
        name: "Sibling",
      });
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      await listingChildren.setIds(parent.id, [child.id]);
      await optInAddOnForListings("Child-scoped extra", [
        child.id,
        rescuingPage.id,
      ]);

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/deactivate`,
        { confirm_identifier: "Rescue Group" },
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(
        `/admin/groups/${group.id}/bulk-actions/deactivate`,
      );
      // No listing was deactivated — the batch was blocked entirely.
      expect((await getListingWithCount(rescuingPage.id))?.active).toBe(true);
      expect((await getListingWithCount(sibling.id))?.active).toBe(true);
    });
  });
});
