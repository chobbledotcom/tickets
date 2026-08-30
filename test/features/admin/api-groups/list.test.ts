// JSON CRUD coverage for the group resource behind the migrated group entity
// page (groups.ts). Kept in the mutation gate's changed set so groups.ts's
// whole-file mutants meet their real covering tests.
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  groupWithMember,
  packagedGroup,
  putGroup,
} from "#test/features/admin/groups/helpers.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  apiRequest,
  createTestManagerSession,
  requestAsSession,
  testCsrfToken,
} from "#test-utils/session.ts";

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
