// JSON CRUD coverage for the group resource behind the migrated group entity
// page (groups.ts): the create/update/delete validation shared with the web
// edit route. Kept in the mutation gate's changed set alongside the entity-page
// migration so groups.ts's whole-file mutants meet their real covering tests.
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { getDb } from "#shared/db/client.ts";
import { groups, listingGroups } from "#shared/db/groups.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import {
  assertApiDeleteOk,
  assertJson,
  expectRejectsEmptyName,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  apiRequest,
  createTestManagerSession,
  requestAsSession,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";
import { groupWithMember, packagedGroup, putGroup } from "./groups/helpers.ts";

describeWithEnv("Admin API - Groups", { db: true }, () => {
  describe("GET /api/admin/groups", () => {
    test("lists all groups", async () => {
      await createTestGroup({ name: "Group A" });
      await createTestGroup({ name: "Group B" });

      await assertJson(apiRequest("/api/admin/groups"), 200, (body) => {
        expect(body.groups.length).toBe(2);
        // slug_index should be stripped from response
        for (const group of body.groups) {
          expect(group.slug_index).toBeUndefined();
        }
      });
    });

    test("returns empty array when no groups", async () => {
      await assertJson(apiRequest("/api/admin/groups"), 200, (body) => {
        expect(body.groups).toEqual([]);
      });
    });

    test("batch-hydrates package_members (and day_prices) across the list", async () => {
      const withMember = await packagedGroup("Listed", 700);
      const emptyPackage = await createTestGroup({
        isPackage: true,
        name: "EmptyPkg",
        slug: "empty-pkg",
      });
      const plain = await createTestGroup({ name: "Plain", slug: "plain" });
      // A second package whose member carries a per-day override, so the list's
      // bulk day-price hydration is exercised alongside override-free groups.
      const { group: dayGroup, listing: dayListing } =
        await groupWithMember("ListedDays");
      await putGroup(dayGroup.id, {
        is_package: true,
        package_members: [
          { day_prices: { "2": 800 }, listing_id: dayListing.id, price: null },
        ],
      });

      await assertJson(apiRequest("/api/admin/groups"), 200, (body) => {
        const byId = new Map<
          number,
          { package_members?: { day_prices?: unknown }[] }
        >(body.groups.map((g: { id: number }) => [g.id, g]));
        // A package group with a member carries its override; one without day
        // overrides carries no day_prices key.
        expect(byId.get(withMember.id)?.package_members).toHaveLength(1);
        expect(
          byId.get(withMember.id)?.package_members?.[0]?.day_prices,
        ).toBeUndefined();
        expect(byId.get(dayGroup.id)?.package_members?.[0]?.day_prices).toEqual(
          { "2": 800 },
        );
        // A package group with no listings hydrates to an empty member list.
        expect(byId.get(emptyPackage.id)?.package_members).toEqual([]);
        // A non-package group carries no package_members field at all.
        expect(byId.get(plain.id)?.package_members).toBeUndefined();
      });
    });

    test("returns 401 without auth", async () => {
      const response = await handleRequest(mockRequest("/api/admin/groups"));
      expect(response.status).toBe(401);
    });
  });

  describe("GET /api/admin/groups/:groupId", () => {
    test("returns single group by ID", async () => {
      const group = await createTestGroup({ name: "Detail Group" });

      await assertJson(
        apiRequest(`/api/admin/groups/${group.id}`),
        200,
        (body) => {
          expect(body.group.name).toBe("Detail Group");
          expect(body.group.id).toBe(group.id);
          expect(body.group.slug).toBeDefined();
          expect(body.group.slug_index).toBeUndefined();
        },
      );
    });

    test("returns 404 for non-existent group", async () => {
      await assertJson(apiRequest("/api/admin/groups/99999"), 404, (body) => {
        expect(body.error).toBe("Group not found");
      });
    });

    test("works with cookie+CSRF auth", async () => {
      const group = await createTestGroup({ name: "Cookie Group" });
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      await assertJson(
        handleRequest(
          requestAsSession(`/api/admin/groups/${group.id}`, {
            cookie,
            csrfToken,
          }),
        ),
        200,
        (body) => {
          expect(body.group.name).toBe("Cookie Group");
        },
      );
    });

    test("returns 404 when the group vanishes during update", async () => {
      const group = await createTestGroup({ name: "Vanishing group" });
      await getDb().execute(
        `CREATE TRIGGER delete_group_during_update
         AFTER UPDATE ON groups
         WHEN NEW.id = ${group.id}
         BEGIN
           DELETE FROM groups WHERE id = NEW.id;
         END`,
      );

      try {
        await assertJson(
          apiRequest(`/api/admin/groups/${group.id}`, {
            body: { name: "Gone" },
            method: "PUT",
          }),
          404,
          (body) => {
            expect(body.error).toBe("Group not found");
          },
        );
      } finally {
        await getDb().execute(
          "DROP TRIGGER IF EXISTS delete_group_during_update",
        );
      }
    });
  });

  describe("POST /api/admin/groups", () => {
    test("creates group with name only", async () => {
      await assertJson(
        apiRequest("/api/admin/groups", {
          body: { name: "New Group" },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.group.name).toBe("New Group");
          expect(body.group.id).toBeGreaterThan(0);
          expect(body.group.slug).toBeDefined();
          expect(body.group.slug_index).toBeUndefined();
          expect(body.group.max_attendees).toBe(0);
        },
      );
    });

    test("still creates when the read-back replica lags the just-committed write", async () => {
      // Regression (JSON API, shared crud write-back): after committing the row in
      // a transaction on the primary, the API read it back with a plain "read"-mode
      // plain read, which Turso can serve from a replica lagging the commit —
      // returning null and crashing on `row.id`. The read-back now uses the
      // primary-pinned `findByIdPrimary`. Stub the optional replica read to
      // miss the row — the create must still succeed.
      const readStub = stub(groups.table.read, "one", () =>
        Promise.resolve(null),
      );
      try {
        await assertJson(
          apiRequest("/api/admin/groups", {
            body: { name: "Lagged API Group" },
            method: "POST",
          }),
          201,
          (body) => {
            expect(body.group.name).toBe("Lagged API Group");
            expect(body.group.id).toBeGreaterThan(0);
          },
        );
      } finally {
        readStub.restore();
      }
    });

    test("creates group with all fields", async () => {
      await assertJson(
        apiRequest("/api/admin/groups", {
          body: {
            description: "Full group description",
            max_attendees: 50,
            name: "Full Group",
            terms_and_conditions: "Some terms",
          },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.group.name).toBe("Full Group");
          expect(body.group.description).toBe("Full group description");
          expect(body.group.max_attendees).toBe(50);
          expect(body.group.terms_and_conditions).toBe("Some terms");
        },
      );
    });

    test("creates a group with an explicit zero capacity", async () => {
      await assertJson(
        apiRequest("/api/admin/groups", {
          body: { max_attendees: 0, name: "Unlimited Group" },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.group.max_attendees).toBe(0);
        },
      );
    });

    test("creates group without description defaults to empty string", async () => {
      await assertJson(
        apiRequest("/api/admin/groups", {
          body: { name: "No Desc" },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.group.description).toBe("");
        },
      );
    });

    test("creates group with hidden flag", async () => {
      await assertJson(
        apiRequest("/api/admin/groups", {
          body: { hidden: true, name: "Hidden Group" },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.group.name).toBe("Hidden Group");
          expect(body.group.hidden).toBe(true);
        },
      );
    });

    test("creates group without hidden flag by default", async () => {
      await assertJson(
        apiRequest("/api/admin/groups", {
          body: { name: "Visible Group" },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.group.hidden).toBe(false);
        },
      );
    });

    test("rejects malformed catalog fields", async () => {
      for (const { body, field } of [
        {
          body: { max_attendees: "10", name: "Bad capacity type" },
          field: "max_attendees",
        },
        {
          body: { max_attendees: -1, name: "Bad capacity value" },
          field: "max_attendees",
        },
        { body: { hidden: "true", name: "Bad visibility" }, field: "hidden" },
      ]) {
        await assertJson(
          apiRequest("/api/admin/groups", { body, method: "POST" }),
          400,
          (response) => {
            expect(response.error).toBe(`${field} has an invalid value`);
          },
        );
      }
    });

    test("returns error when name is missing", async () => {
      await assertJson(
        apiRequest("/api/admin/groups", {
          body: { max_attendees: 10 },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe("name is required");
        },
      );
    });

    test("rejects a group name already used by another group", async () => {
      await assertJson(
        apiRequest("/api/admin/groups", {
          body: { name: "Unique API Group" },
          method: "POST",
        }),
        201,
      );
      await assertJson(
        apiRequest("/api/admin/groups", {
          body: { name: "Unique API Group" },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe(
            "Name is already in use by another listing or group",
          );
        },
      );
    });

    test("auto-generates unique slug", async () => {
      const result1 = await assertJson(
        apiRequest("/api/admin/groups", {
          body: { name: "Slug Test 1" },
          method: "POST",
        }),
        201,
      );
      const result2 = await assertJson(
        apiRequest("/api/admin/groups", {
          body: { name: "Slug Test 2" },
          method: "POST",
        }),
        201,
      );
      expect(result1.group.slug).toBeDefined();
      expect(result2.group.slug).toBeDefined();
      expect(result1.group.slug).not.toBe(result2.group.slug);
    });
  });

  describe("PUT /api/admin/groups/:groupId", () => {
    test("updates group name", async () => {
      const group = await createTestGroup({ name: "Old Group" });

      await assertJson(
        apiRequest(`/api/admin/groups/${group.id}`, {
          body: { name: "New Group Name" },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.group.name).toBe("New Group Name");
          expect(body.group.slug).toBe(group.slug);
        },
      );
    });

    test("updates slug", async () => {
      const group = await createTestGroup({ name: "Slug Group" });

      await assertJson(
        apiRequest(`/api/admin/groups/${group.id}`, {
          body: { slug: "custom-slug" },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.group.slug).toBe("custom-slug");
        },
      );
    });

    test("updates max_attendees and terms", async () => {
      const group = await createTestGroup({
        maxAttendees: 10,
        name: "Update Fields",
      });

      await assertJson(
        apiRequest(`/api/admin/groups/${group.id}`, {
          body: {
            max_attendees: 100,
            terms_and_conditions: "Updated terms",
          },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.group.max_attendees).toBe(100);
          expect(body.group.terms_and_conditions).toBe("Updated terms");
          expect(body.group.name).toBe("Update Fields");
        },
      );
    });

    test("updates description", async () => {
      const group = await createTestGroup({ name: "Desc Group" });

      await assertJson(
        apiRequest(`/api/admin/groups/${group.id}`, {
          body: { description: "New description" },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.group.description).toBe("New description");
          expect(body.group.name).toBe("Desc Group");
        },
      );
    });

    test("preserves description when not provided in update", async () => {
      const created = await assertJson(
        apiRequest("/api/admin/groups", {
          body: { description: "Keep this", name: "Keep Desc" },
          method: "POST",
        }),
        201,
      );

      await assertJson(
        apiRequest(`/api/admin/groups/${created.group.id}`, {
          body: { name: "Renamed" },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.group.name).toBe("Renamed");
          expect(body.group.description).toBe("Keep this");
        },
      );
    });

    test("updates hidden flag", async () => {
      const group = await createTestGroup({ name: "Toggle Group" });

      await assertJson(
        apiRequest(`/api/admin/groups/${group.id}`, {
          body: { hidden: true },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.group.hidden).toBe(true);
        },
      );

      await assertJson(
        apiRequest(`/api/admin/groups/${group.id}`, {
          body: { hidden: false },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.group.hidden).toBe(false);
        },
      );
    });

    test("rejects a malformed catalog field without changing the group", async () => {
      const group = await createTestGroup({ maxAttendees: 12 });

      await assertJson(
        apiRequest(`/api/admin/groups/${group.id}`, {
          body: { max_attendees: "20" },
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toBe("max_attendees has an invalid value");
        },
      );

      expect(
        (await groups.table.read.one({ id: group.id }))?.max_attendees,
      ).toBe(12);
    });

    test("returns 404 for non-existent group", async () => {
      await assertJson(
        apiRequest("/api/admin/groups/99999", {
          body: { name: "Nope" },
          method: "PUT",
        }),
        404,
        (body) => {
          expect(body.error).toBe("Group not found");
        },
      );
    });

    test("rejects empty name", async () => {
      const group = await createTestGroup();
      await expectRejectsEmptyName(`/api/admin/groups/${group.id}`);
    });

    test("rejects duplicate slug", async () => {
      const group1 = await createTestGroup({ name: "Group One" });
      const group2 = await createTestGroup({ name: "Group Two" });

      await assertJson(
        apiRequest(`/api/admin/groups/${group2.id}`, {
          body: { slug: group1.slug },
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toBe("Slug is already in use");
        },
      );
    });
  });

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

  // Groups are managed by any admin in the dashboard (createCrudHandlers), so a
  // manager must retain group access via the JSON API — unlike owner-only
  // holidays. Guards against accidentally over-restricting the group API.
  describe("manager authorization", () => {
    test("allows a manager to list groups", async () => {
      await createTestGroup({ name: "Manager-visible" });
      const res = await handleRequest(
        requestAsSession("/api/admin/groups", {
          cookie: await createTestManagerSession(),
          csrfToken: await testCsrfToken(),
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.groups.length).toBe(1);
    });
  });
});
