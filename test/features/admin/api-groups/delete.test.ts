// JSON CRUD coverage for the group resource behind the migrated group entity
// page (groups.ts). Kept in the mutation gate's changed set so groups.ts's
// whole-file mutants meet their real covering tests.
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { groups, listingGroups } from "#db/groups.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { assertApiDeleteOk, assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { apiRequest } from "#test-utils/session.ts";

describeWithEnv("Admin API - Groups", { db: true }, () => {
  describe("DELETE /api/admin/groups/:groupId", () => {
    test("deletes group with correct confirmation", async () => {
      const group = await createTestGroup({ name: "To Delete" });

      await assertApiDeleteOk(`/api/admin/groups/${group.id}`, "To Delete");

      const all = await groups.cache.getAll();
      expect(all.find((g) => g.id === group.id)).toBeUndefined();
    });

    test("resets listings to ungrouped on delete", async () => {
      const group = await createTestGroup({ name: "Listing Group" });
      const listing = await createTestListing({
        groupId: group.id,
        name: "Grouped Listing",
      });

      await assertJson(
        apiRequest(`/api/admin/groups/${group.id}`, {
          body: { confirm_identifier: "Listing Group" },
          method: "DELETE",
        }),
        200,
      );

      // Deleting the group removes membership; the listing survives, ungrouped.
      expect(await listingGroups.getIds(listing.id)).toEqual([]);
      const listingRow = await getListingWithCount(listing.id);
      expect(listingRow).not.toBeNull();
    });

    test("rejects delete with wrong confirmation", async () => {
      const group = await createTestGroup({ name: "Protected" });

      await assertJson(
        apiRequest(`/api/admin/groups/${group.id}`, {
          body: { confirm_identifier: "Wrong Name" },
          method: "DELETE",
        }),
        400,
        (body) => {
          expect(body.error).toContain("does not match");
        },
      );

      const row = await groups.table.read.one({ id: group.id });
      expect(row).toBeDefined();
    });

    test("returns 404 for non-existent group", async () => {
      await assertJson(
        apiRequest("/api/admin/groups/99999", {
          body: { confirm_identifier: "anything" },
          method: "DELETE",
        }),
        404,
        (body) => {
          expect(body.error).toBe("Group not found");
        },
      );
    });
  });
});
