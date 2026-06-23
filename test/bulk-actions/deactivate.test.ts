import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { setChildIds } from "#shared/db/listing-parents.ts";
import { getListingWithCount } from "#shared/db/listings.ts";
import {
  adminFormPost,
  adminGet,
  createTestGroup,
  createTestListing,
  describeWithEnv,
  insertModifier,
  linkModifierListing,
  patchModifier,
} from "#test-utils";

/** Insert an active opt-in add-on scoped to the given listing ids. */
const optInAddOnForListings = async (
  name: string,
  listingIds: number[],
): Promise<void> => {
  const modifier = await insertModifier({ name });
  await patchModifier(modifier.id, { scope: "listings", trigger: "optional" });
  for (const listingId of listingIds) {
    await linkModifierListing(modifier.id, listingId);
  }
};

describeWithEnv("Admin bulk actions — deactivate", { db: true }, () => {
  describe("GET /admin/groups/:id/bulk-actions/deactivate", () => {
    test("renders the deactivate confirmation form with singular listing count", async () => {
      const group = await createTestGroup({ name: "To Deactivate" });
      await createTestListing({ groupId: group.id, name: "Listing" });

      const { response } = await adminGet(
        `/admin/groups/${group.id}/bulk-actions/deactivate`,
      );
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("Deactivate Group");
      expect(html).toContain('name="confirm_identifier"');
      expect(html).toContain("deactivate 1 active listing");
      expect(html).not.toContain("deactivate 1 active listings");
    });

    test("renders the deactivate form with plural listing count", async () => {
      const group = await createTestGroup({ name: "Multi Deact" });
      await createTestListing({ groupId: group.id, name: "A" });
      await createTestListing({ groupId: group.id, name: "B" });

      const { response } = await adminGet(
        `/admin/groups/${group.id}/bulk-actions/deactivate`,
      );
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain("deactivate 2 active listings");
    });

    test("returns 404 when the group does not exist", async () => {
      const { response } = await adminGet(
        "/admin/groups/999999/bulk-actions/deactivate",
      );
      expect(response.status).toBe(404);
    });
  });

  describe("POST /admin/groups/:id/bulk-actions/deactivate", () => {
    test("deactivates every listing in the group when the name is confirmed", async () => {
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

    test("rejects when the group name does not match and leaves listings active", async () => {
      const group = await createTestGroup({ name: "Keep Active" });
      const listing = await createTestListing({
        groupId: group.id,
        name: "Listing",
      });

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/deactivate`,
        { confirm_identifier: "Wrong Name" },
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(
        `/admin/groups/${group.id}/bulk-actions/deactivate`,
      );
      expect((await getListingWithCount(listing.id))?.active).toBe(true);
    });

    test("rejects deactivating a group that holds the only rescuing page of a child add-on, leaving every listing active (Fix 5)", async () => {
      // A {child, rescuingPage}-scoped opt-in add-on is reachable only via
      // `rescuingPage` (the child is suppressed). `rescuingPage` lives in the
      // group, so a bulk deactivate would mark it inactive together with the
      // group and orphan the add-on. The shared guard must block the whole batch
      // before any UPDATE, leaving every member active.
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
      await setChildIds(parent.id, [child.id]);
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

    test("does not touch listings outside the target group", async () => {
      const target = await createTestGroup({ name: "Target" });
      const other = await createTestGroup({ name: "Other" });
      await createTestListing({ groupId: target.id, name: "Target Listing" });
      const outsider = await createTestListing({
        groupId: other.id,
        name: "Outsider Listing",
      });

      await adminFormPost(
        `/admin/groups/${target.id}/bulk-actions/deactivate`,
        { confirm_identifier: "Target" },
      );

      expect((await getListingWithCount(outsider.id))?.active).toBe(true);
    });
  });
});
