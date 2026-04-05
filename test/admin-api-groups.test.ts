import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  getAllGroups,
  getEventsByGroupId,
  groupsTable,
} from "#lib/db/groups.ts";
import { handleRequest } from "#routes";
import {
  apiRequest,
  assertJson,
  createTestEvent,
  createTestGroup,
  describeWithEnv,
  mockRequest,
  requestAsSession,
  testCookie,
  testCsrfToken,
} from "#test-utils";

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
        expect(body.message).toBe("Group not found");
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

  describe("POST /api/admin/groups", () => {
    test("creates group with name only", async () => {
      await assertJson(
        apiRequest("/api/admin/groups", {
          method: "POST",
          body: { name: "New Group" },
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

    test("creates group with all fields", async () => {
      await assertJson(
        apiRequest("/api/admin/groups", {
          method: "POST",
          body: {
            name: "Full Group",
            max_attendees: 50,
            terms_and_conditions: "Some terms",
          },
        }),
        201,
        (body) => {
          expect(body.group.name).toBe("Full Group");
          expect(body.group.max_attendees).toBe(50);
          expect(body.group.terms_and_conditions).toBe("Some terms");
        },
      );
    });

    test("creates group with hidden flag", async () => {
      await assertJson(
        apiRequest("/api/admin/groups", {
          method: "POST",
          body: { name: "Hidden Group", hidden: true },
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
          method: "POST",
          body: { name: "Visible Group" },
        }),
        201,
        (body) => {
          expect(body.group.hidden).toBe(false);
        },
      );
    });

    test("returns error when name is missing", async () => {
      await assertJson(
        apiRequest("/api/admin/groups", {
          method: "POST",
          body: { max_attendees: 10 },
        }),
        400,
        (body) => {
          expect(body.message).toBe("name is required");
        },
      );
    });

    test("auto-generates unique slug", async () => {
      const result1 = await assertJson(
        apiRequest("/api/admin/groups", {
          method: "POST",
          body: { name: "Slug Test 1" },
        }),
        201,
      );
      const result2 = await assertJson(
        apiRequest("/api/admin/groups", {
          method: "POST",
          body: { name: "Slug Test 2" },
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
          method: "PUT",
          body: { name: "New Group Name" },
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
          method: "PUT",
          body: { slug: "custom-slug" },
        }),
        200,
        (body) => {
          expect(body.group.slug).toBe("custom-slug");
        },
      );
    });

    test("updates max_attendees and terms", async () => {
      const group = await createTestGroup({
        name: "Update Fields",
        maxAttendees: 10,
      });

      await assertJson(
        apiRequest(`/api/admin/groups/${group.id}`, {
          method: "PUT",
          body: {
            max_attendees: 100,
            terms_and_conditions: "Updated terms",
          },
        }),
        200,
        (body) => {
          expect(body.group.max_attendees).toBe(100);
          expect(body.group.terms_and_conditions).toBe("Updated terms");
          expect(body.group.name).toBe("Update Fields");
        },
      );
    });

    test("updates hidden flag", async () => {
      const group = await createTestGroup({ name: "Toggle Group" });

      await assertJson(
        apiRequest(`/api/admin/groups/${group.id}`, {
          method: "PUT",
          body: { hidden: true },
        }),
        200,
        (body) => {
          expect(body.group.hidden).toBe(true);
        },
      );

      await assertJson(
        apiRequest(`/api/admin/groups/${group.id}`, {
          method: "PUT",
          body: { hidden: false },
        }),
        200,
        (body) => {
          expect(body.group.hidden).toBe(false);
        },
      );
    });

    test("returns 404 for non-existent group", async () => {
      await assertJson(
        apiRequest("/api/admin/groups/99999", {
          method: "PUT",
          body: { name: "Nope" },
        }),
        404,
        (body) => {
          expect(body.message).toBe("Group not found");
        },
      );
    });

    test("rejects empty name", async () => {
      const group = await createTestGroup();

      await assertJson(
        apiRequest(`/api/admin/groups/${group.id}`, {
          method: "PUT",
          body: { name: "" },
        }),
        400,
        (body) => {
          expect(body.message).toBe("name cannot be empty");
        },
      );
    });

    test("rejects duplicate slug", async () => {
      const group1 = await createTestGroup({ name: "Group One" });
      const group2 = await createTestGroup({ name: "Group Two" });

      await assertJson(
        apiRequest(`/api/admin/groups/${group2.id}`, {
          method: "PUT",
          body: { slug: group1.slug },
        }),
        400,
        (body) => {
          expect(body.message).toBe("Slug is already in use");
        },
      );
    });
  });

  describe("DELETE /api/admin/groups/:groupId", () => {
    test("deletes group with correct confirmation", async () => {
      const group = await createTestGroup({ name: "To Delete" });

      await assertJson(
        apiRequest(`/api/admin/groups/${group.id}`, {
          method: "DELETE",
          body: { confirm_identifier: "To Delete" },
        }),
        200,
        (body) => {
          expect(body.status).toBe("ok");
        },
      );

      const all = await getAllGroups();
      expect(all.find((g) => g.id === group.id)).toBeUndefined();
    });

    test("resets events to ungrouped on delete", async () => {
      const group = await createTestGroup({ name: "Event Group" });
      const event = await createTestEvent({
        name: "Grouped Event",
        groupId: group.id,
      });

      await assertJson(
        apiRequest(`/api/admin/groups/${group.id}`, {
          method: "DELETE",
          body: { confirm_identifier: "Event Group" },
        }),
        200,
      );

      // Event should now be ungrouped (group_id = 0)
      const events = await getEventsByGroupId(0);
      const found = events.find((e) => e.id === event.id);
      expect(found).toBeDefined();
    });

    test("rejects delete with wrong confirmation", async () => {
      const group = await createTestGroup({ name: "Protected" });

      await assertJson(
        apiRequest(`/api/admin/groups/${group.id}`, {
          method: "DELETE",
          body: { confirm_identifier: "Wrong Name" },
        }),
        400,
        (body) => {
          expect(body.message).toContain("does not match");
        },
      );

      const row = await groupsTable.findById(group.id);
      expect(row).toBeDefined();
    });

    test("returns 404 for non-existent group", async () => {
      await assertJson(
        apiRequest("/api/admin/groups/99999", {
          method: "DELETE",
          body: { confirm_identifier: "anything" },
        }),
        404,
        (body) => {
          expect(body.message).toBe("Group not found");
        },
      );
    });
  });
});
