// JSON CRUD coverage for the group resource behind the migrated group entity
// page (groups.ts). Kept in the mutation gate's changed set so groups.ts's
// whole-file mutants meet their real covering tests.
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { listingGroups } from "#db/groups/table.ts";
import { groups } from "#db/groups.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import { assertApiDeleteOk, assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  apiRequest,
  createTestAgentSession,
  createTestEditorSession,
  createTestManagerSession,
  requestAsSession,
} from "#test-utils/session.ts";

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

  // Role parity with the delete page: the dashboard's groupDelete route is
  // staff-only (areas-a-l.ts), so an editor — who edits groups there — must
  // still be refused here, and the staff roles must not lose the delete.
  describe("delete role parity", () => {
    const deleteAs = async (
      cookie: string,
      csrfToken: string,
      groupId: number,
      name: string,
    ): Promise<Response> =>
      handleRequest(
        requestAsSession(
          `/api/admin/groups/${groupId}`,
          { cookie, csrfToken },
          {
            body: JSON.stringify({ confirm_identifier: name }),
            headers: { "content-type": "application/json" },
            method: "DELETE",
          },
        ),
      );

    test("refuses a role below staff with 403 and keeps the group", async () => {
      const refusals = [
        { make: createTestAgentSession, name: "Agent Proof" },
        { make: createTestEditorSession, name: "Editor Proof" },
      ];
      for (const { make, name } of refusals) {
        const group = await createTestGroup({ name });
        const role = await make();
        const cookie = typeof role === "string" ? role : role.cookie;

        const response = await deleteAs(
          cookie,
          await signCsrfToken(),
          group.id,
          name,
        );
        expect(response.status).toBe(403);

        const all = await groups.cache.getAll();
        expect(all.find((g) => g.id === group.id)).toBeDefined();
      }
    });

    test("admits a manager cookie session", async () => {
      const group = await createTestGroup({ name: "Manager Proof" });

      const response = await deleteAs(
        await createTestManagerSession(),
        await signCsrfToken(),
        group.id,
        "Manager Proof",
      );
      expect(response.status).toBe(200);

      const all = await groups.cache.getAll();
      expect(all.find((g) => g.id === group.id)).toBeUndefined();
    });
  });
});
