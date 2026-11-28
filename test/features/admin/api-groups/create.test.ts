// JSON CRUD coverage for the group resource behind the migrated group entity
// page (groups.ts). Kept in the mutation gate's changed set so groups.ts's
// whole-file mutants meet their real covering tests.
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getDb } from "#db/client.ts";
import { groups } from "#db/groups.ts";
import type { SqlStatement } from "#db/sql.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  expectApiRecord,
  type JsonBody,
  postJson,
  requestAs,
} from "#test-utils/api/admin-json.ts";
import { assertJson, expectApiError } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";
import {
  createTestAgentSession,
  createTestEditorSession,
} from "#test-utils/session.ts";

const GROUPS = "/api/admin/groups";

/** Send a new group to the admin API with an API key. */
const postGroup = (body: JsonBody): Promise<Response> => postJson(GROUPS, body);

/** Create a group through the admin API and check the group it gives back. */
const createGroup = (
  body: JsonBody,
  check?: (group: JsonBody) => void,
): Promise<JsonBody> => expectApiRecord("group")(postGroup(body), 201, check);

/** Send a new group named `name` to the admin API as a cookie session. */
const postGroupAs = async (cookie: string, name: string): Promise<Response> =>
  requestAs({ cookie, csrfToken: await signCsrfToken() }, GROUPS, {
    body: { name },
    method: "POST",
  });

describeWithEnv("Admin API - Groups", { db: true }, () => {
  describe("POST /api/admin/groups", () => {
    test("creates group with name only", async () => {
      await createGroup({ name: "New Group" }, (group) => {
        expect(group.name).toBe("New Group");
        expect(group.id).toBeGreaterThan(0);
        expect(group.slug).toMatch(/^[0-9a-h]{5}$/);
        expect(group.max_attendees).toBe(0);
        expect(group).not.toHaveProperty("slug_index");
      });
    });

    // Role parity with the group pages: the new-group page admits content
    // admins (owner, manager, editor — areas-a-l.ts "groups"), so an editor
    // creates through the API too, and a role below content is refused.
    test("admits an editor cookie session", async () => {
      const editor = await createTestEditorSession();
      await assertJson(
        postGroupAs(editor.cookie, "Editor Made Group"),
        201,
        (body) => {
          expect(body.group.name).toBe("Editor Made Group");
        },
      );
    });

    test("refuses an agent with 403 and creates nothing", async () => {
      const agent = await createTestAgentSession();
      const response = await postGroupAs(agent.cookie, "Agent Made Group");
      expect(response.status).toBe(403);
      const all = await groups.getAll();
      expect(all.map((g) => g.name)).not.toContain("Agent Made Group");
    });

    test("returns 400 when the name is longer than 250 characters", async () => {
      // A concealed package order carries the group's name on Square's line
      // items, so a name past the catalog length must be refused, not stored.
      await expectApiError(
        postGroup({ name: "G".repeat(251) }),
        400,
        "Name must be 250 characters or fewer",
      );
      await createGroup({ name: "G".repeat(250) });
    });

    test("still creates when the read-back replica lags the just-committed write", async () => {
      // Regression (JSON API, shared crud write-back): after committing the row in
      // a transaction on the primary, the API read it back with a plain "read"-mode
      // plain read, which Turso can serve from a replica lagging the commit —
      // returning null and crashing on `row.id`. The read-back now uses the
      // primary-pinned `findRowPrimary`. A replica read of one group by id
      // misses the row. The create must still succeed.
      const db = getDb();
      const realExecute = db.execute.bind(db);
      using _replica = stub(db, "execute", (statement: SqlStatement) =>
        statement.sql.includes("FROM groups AS groupRow WHERE groupRow.id =")
          ? Promise.resolve(emptyResultSet())
          : realExecute(statement),
      );
      await createGroup({ name: "Lagged API Group" }, (group) => {
        expect(group.name).toBe("Lagged API Group");
        expect(group.id).toBeGreaterThan(0);
      });
    });

    test("creates group with all fields", async () => {
      await createGroup(
        {
          description: "Full group description",
          max_attendees: 50,
          name: "Full Group",
          terms_and_conditions: "Some terms",
        },
        (group) => {
          expect(group.name).toBe("Full Group");
          expect(group.description).toBe("Full group description");
          expect(group.max_attendees).toBe(50);
          expect(group.terms_and_conditions).toBe("Some terms");
        },
      );
    });

    test("creates a group with an explicit zero capacity", async () => {
      await createGroup(
        { max_attendees: 0, name: "Unlimited Group" },
        (group) => expect(group.max_attendees).toBe(0),
      );
    });

    test("creates group without description defaults to empty string", async () => {
      await createGroup({ name: "No Desc" }, (group) =>
        expect(group.description).toBe(""),
      );
    });

    test("creates group with hidden flag", async () => {
      await createGroup({ hidden: true, name: "Hidden Group" }, (group) => {
        expect(group.name).toBe("Hidden Group");
        expect(group.hidden).toBe(true);
      });
    });

    test("creates group without hidden flag by default", async () => {
      await createGroup({ name: "Visible Group" }, (group) =>
        expect(group.hidden).toBe(false),
      );
    });

    test("rejects malformed catalog fields", async () => {
      for (const { body, error } of [
        {
          body: { max_attendees: "10", name: "Bad capacity type" },
          error: "max_attendees has an invalid value",
        },
        {
          body: { max_attendees: -1, name: "Bad capacity value" },
          error: "max_attendees has an invalid value",
        },
        {
          body: { hidden: "true", name: "Bad visibility" },
          error: "hidden must be a boolean",
        },
      ]) {
        await expectApiError(postGroup(body), 400, error);
      }
    });

    test("returns error when name is missing", async () => {
      await expectApiError(
        postGroup({ max_attendees: 10 }),
        400,
        "name is required",
      );
    });

    test("rejects a group name already used by another group", async () => {
      await createGroup({ name: "Unique API Group" });
      await expectApiError(
        postGroup({ name: "Unique API Group" }),
        400,
        "Name is already in use by another listing or group",
      );
    });

    test("auto-generates unique slug", async () => {
      const result1 = await createGroup({ name: "Slug Test 1" });
      const result2 = await createGroup({ name: "Slug Test 2" });
      expect(result1.slug).toMatch(/^[0-9a-h]{5}$/);
      expect(result2.slug).toMatch(/^[0-9a-h]{5}$/);
      expect(result1.slug).not.toBe(result2.slug);
    });
  });
});
