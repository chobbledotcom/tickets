// JSON CRUD coverage for the group resource behind the migrated group entity
// page (groups.ts). Kept in the mutation gate's changed set so groups.ts's
// whole-file mutants meet their real covering tests.
// jscpd:ignore-start -- imports
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  apiRequest,
  requestAsSession,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";

// jscpd:ignore-end

describeWithEnv("Admin API - Groups", { db: true }, () => {
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
  });
});
