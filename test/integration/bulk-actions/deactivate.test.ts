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
  });

  describe("POST /admin/groups/:id/bulk-actions/deactivate", () => {
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
