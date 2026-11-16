// JSON CRUD coverage for the group resource behind the migrated group entity
// page (groups.ts). Kept in the mutation gate's changed set so groups.ts's
// whole-file mutants meet their real covering tests.
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { records } from "#db/record-table.ts";
import { sql, sqlLiteral } from "#db/sql.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  expectApiRecord,
  type JsonBody,
  postJson,
  putJson,
  requestAs,
} from "#test-utils/api/admin-json.ts";
import {
  expectApiError,
  expectRejectsEmptyName,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestAgentSession,
  createTestEditorSession,
} from "#test-utils/session.ts";

/** The path of one group in the admin API. */
const groupPath = (id: number | string): string => `/api/admin/groups/${id}`;

/** The group that an admin API answer holds. */
const expectGroup = expectApiRecord("group");

/** Rename a group through the admin API as a signed-in session. */
const renameAs = async (cookie: string, id: number, name: string) =>
  requestAs({ cookie, csrfToken: await signCsrfToken() }, groupPath(id), {
    body: { name },
    method: "PUT",
  });

/** Change a new group through the admin API and check the group that the
 *  answer holds. */
const expectGroupChange = async (
  fields: Parameters<typeof createTestGroup>[0],
  changes: JsonBody,
  check: (group: JsonBody) => void,
): Promise<void> => {
  const group = await createTestGroup(fields);
  await expectGroup(putJson(groupPath(group.id), changes), 200, check);
};

describeWithEnv("Admin API - Groups", { db: true }, () => {
  describe("PUT /api/admin/groups/:groupId", () => {
    test("updates group name", async () => {
      const group = await createTestGroup({ name: "Old Group" });

      await expectGroup(
        putJson(groupPath(group.id), { name: "New Group Name" }),
        200,
        (row) => {
          expect(row.name).toBe("New Group Name");
          expect(row.slug).toBe(group.slug);
        },
      );
    });

    // Role parity with the group edit page: it admits content admins (owner,
    // manager, editor — areas-a-l.ts "groups"), so an editor updates through
    // the API too, and a role below content is refused.
    test("admits an editor cookie session", async () => {
      const group = await createTestGroup({ name: "Editor Edit" });
      const editor = await createTestEditorSession();

      await expectGroup(
        renameAs(editor.cookie, group.id, "Editor Renamed"),
        200,
        (row) => expect(row.name).toBe("Editor Renamed"),
      );
    });

    test("refuses an agent with 403 and changes nothing", async () => {
      const group = await createTestGroup({ name: "Agent Edit" });
      const agent = await createTestAgentSession();

      const response = await renameAs(agent.cookie, group.id, "Agent Renamed");
      expect(response.status).toBe(403);
      const row = await records.groups.find(group.id);
      expect(row?.name).toBe("Agent Edit");
    });

    test("refuses a malformed catalog field, naming the field", async () => {
      const group = await createTestGroup({ name: "Catalog Guard" });

      await expectApiError(
        putJson(groupPath(group.id), {
          hidden: "maybe",
          name: "Catalog Guard",
        }),
        400,
        "hidden has an invalid value",
      );
    });

    test("updates slug", async () => {
      await expectGroupChange(
        { name: "Slug Group" },
        { slug: "custom-slug" },
        (row) => expect(row.slug).toBe("custom-slug"),
      );
    });

    test("updates max_attendees and terms", async () => {
      await expectGroupChange(
        { maxAttendees: 10, name: "Update Fields" },
        { max_attendees: 100, terms_and_conditions: "Updated terms" },
        (row) => {
          expect(row.max_attendees).toBe(100);
          expect(row.terms_and_conditions).toBe("Updated terms");
          expect(row.name).toBe("Update Fields");
        },
      );
    });

    test("updates description", async () => {
      await expectGroupChange(
        { name: "Desc Group" },
        { description: "New description" },
        (row) => {
          expect(row.description).toBe("New description");
          expect(row.name).toBe("Desc Group");
        },
      );
    });

    test("preserves description when not provided in update", async () => {
      const created = await expectGroup(
        postJson("/api/admin/groups", {
          description: "Keep this",
          name: "Keep Desc",
        }),
        201,
      );

      await expectGroup(
        putJson(groupPath(String(created.id)), { name: "Renamed" }),
        200,
        (row) => {
          expect(row.name).toBe("Renamed");
          expect(row.description).toBe("Keep this");
        },
      );
    });

    test("updates hidden flag", async () => {
      const group = await createTestGroup({ name: "Toggle Group" });

      for (const hidden of [true, false]) {
        await expectGroup(
          putJson(groupPath(group.id), { hidden }),
          200,
          (row) => expect(row.hidden).toBe(hidden),
        );
      }
    });

    test("rejects a malformed catalog field without changing the group", async () => {
      const group = await createTestGroup({ maxAttendees: 12 });

      await expectApiError(
        putJson(groupPath(group.id), { max_attendees: "20" }),
        400,
        "max_attendees has an invalid value",
      );

      expect((await records.groups.find(group.id))?.max_attendees).toBe(12);
    });

    test("returns 404 for non-existent group", async () => {
      await expectApiError(
        putJson(groupPath(99999), { name: "Nope" }),
        404,
        "Group not found",
      );
    });

    test("returns 404 when the group vanishes during update", async () => {
      const group = await createTestGroup({ name: "Vanishing group" });
      await getDb().execute(
        sql`CREATE TRIGGER delete_group_during_update
         AFTER UPDATE ON groups
         WHEN NEW.id = ${sqlLiteral(group.id)}
         BEGIN
           DELETE FROM groups WHERE id = NEW.id;
         END`,
      );

      try {
        await expectApiError(
          putJson(groupPath(group.id), { name: "Gone" }),
          404,
          "Group not found",
        );
      } finally {
        await getDb().execute(
          sql`DROP TRIGGER IF EXISTS delete_group_during_update`,
        );
      }
    });

    test("rejects empty name", async () => {
      const group = await createTestGroup();
      await expectRejectsEmptyName(groupPath(group.id));
    });

    test("rejects duplicate slug", async () => {
      const group1 = await createTestGroup({ name: "Group One" });
      const group2 = await createTestGroup({ name: "Group Two" });

      await expectApiError(
        putJson(groupPath(group2.id), { slug: group1.slug }),
        400,
        "Slug is already in use",
      );
    });
  });
});
