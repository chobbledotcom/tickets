// JSON CRUD coverage for the group resource behind the migrated group entity
// page (groups.ts). Kept in the mutation gate's changed set so groups.ts's
// whole-file mutants meet their real covering tests.
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { groups } from "#db/groups.ts";
import { assertJson, expectRejectsEmptyName } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { apiRequest } from "#test-utils/session.ts";

describeWithEnv("Admin API - Groups", { db: true }, () => {
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

    test("refuses a malformed catalog field, naming the field", async () => {
      const group = await createTestGroup({ name: "Catalog Guard" });

      await assertJson(
        apiRequest(`/api/admin/groups/${group.id}`, {
          body: { hidden: "maybe", name: "Catalog Guard" },
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toBe("hidden has an invalid value");
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
});
