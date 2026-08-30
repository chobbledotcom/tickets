// JSON CRUD coverage for the group resource behind the migrated group entity
// page (groups.ts). Kept in the mutation gate's changed set so groups.ts's
// whole-file mutants meet their real covering tests.
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { groups } from "#db/groups.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { apiRequest } from "#test-utils/session.ts";

describeWithEnv("Admin API - Groups", { db: true }, () => {
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
          expect(body.group.max_attendees).toBe(0);
          expect(body.group.slug_index).toBeUndefined();
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
});
