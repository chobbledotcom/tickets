import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  getAllGroups,
  getGroupIdsByListingId,
  getGroupPackagePrices,
  getUngroupedListings,
  groupsTable,
} from "#shared/db/groups.ts";
import {
  apiRequest,
  assertJson,
  createTestGroup,
  createTestListing,
  createTestManagerSession,
  describeWithEnv,
  expectRejectsEmptyName,
  mockRequest,
  requestAsSession,
  testCookie,
  testCsrfToken,
} from "#test-utils";

/** Create a package group with one member carrying a `price` override via the
 * JSON API, returning the group. */
const packagedGroup = async (name: string, price: number) => {
  const group = await createTestGroup({ isPackage: true, name });
  const listing = await createTestListing({ groupId: group.id });
  await apiRequest(`/api/admin/groups/${group.id}`, {
    body: {
      is_package: true,
      package_members: [{ listing_id: listing.id, price }],
    },
    method: "PUT",
  });
  return group;
};

/** A fresh group with one member listing, for package PUT tests. */
const groupWithMember = async (name: string) => {
  const group = await createTestGroup({ name });
  const listing = await createTestListing({ groupId: group.id });
  return { group, listing };
};

/** PUT a group via the JSON API. */
const putGroup = (groupId: number, body: Record<string, unknown>) =>
  apiRequest(`/api/admin/groups/${groupId}`, { body, method: "PUT" });

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

      await assertJson(
        apiRequest(`/api/admin/groups/${group.id}`, {
          body: { confirm_identifier: "To Delete" },
          method: "DELETE",
        }),
        200,
        (body) => {
          expect(body.status).toBe("ok");
        },
      );

      const all = await getAllGroups();
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
      expect(await getGroupIdsByListingId(listing.id)).toEqual([]);
      const ungrouped = await getUngroupedListings();
      expect(ungrouped.find((e) => e.id === listing.id)).toBeDefined();
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

      const row = await groupsTable.findById(group.id);
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

  describe("package fields", () => {
    test("POST persists is_package and hide_package_listings", async () => {
      await assertJson(
        apiRequest("/api/admin/groups", {
          body: {
            hide_package_listings: true,
            is_package: true,
            name: "API Package",
          },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.group.is_package).toBe(true);
          expect(body.group.hide_package_listings).toBe(true);
        },
      );
    });

    test("PUT rejects malformed package members (bad id, price, or quantity)", async () => {
      const { group, listing } = await groupWithMember("BadMembers");
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ listing_id: -1, price: 100 }, "listing_id"],
        [{ listing_id: listing.id, price: -5 }, "price"],
        [{ listing_id: listing.id, price: 100, quantity: 0 }, "quantity"],
      ];
      for (const [member, errorSubstring] of cases) {
        await assertJson(
          putGroup(group.id, { is_package: true, package_members: [member] }),
          400,
          (body) => {
            expect(body.error).toContain(errorSubstring);
          },
        );
      }
    });

    test("POST rejects a malformed package member", async () => {
      await assertJson(
        apiRequest("/api/admin/groups", {
          body: {
            is_package: true,
            name: "BadCreate",
            package_members: [null],
          },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toContain("package_members");
        },
      );
    });

    test("PUT updates hide_package_listings", async () => {
      const group = await packagedGroup("HideUpd", 500);
      await assertJson(
        putGroup(group.id, { hide_package_listings: true, is_package: true }),
        200,
        (body) => {
          expect(body.group.hide_package_listings).toBe(true);
        },
      );
    });

    test("PUT sets is_package, package member prices and quantities", async () => {
      const { group, listing } = await groupWithMember("PUT Pkg");

      await assertJson(
        putGroup(group.id, {
          is_package: true,
          package_members: [
            { listing_id: listing.id, price: 2500, quantity: 3 },
          ],
        }),
        200,
        (body) => {
          expect(body.group.is_package).toBe(true);
        },
      );
      const rows = await getGroupPackagePrices(group.id);
      expect(rows).toEqual([
        {
          group_id: group.id,
          listing_id: listing.id,
          package_price: 2500,
          quantity: 3,
        },
      ]);
    });

    test("PUT defaults a member's quantity to 1 when omitted", async () => {
      const group = await packagedGroup("DefaultQty", 900);
      const rows = await getGroupPackagePrices(group.id);
      expect(rows[0]!.quantity).toBe(1);
    });

    test("PUT without package_members leaves existing overrides untouched", async () => {
      const group = await packagedGroup("Keep", 800);

      // A name-only update must not wipe the saved override.
      await apiRequest(`/api/admin/groups/${group.id}`, {
        body: { name: "Keep Renamed" },
        method: "PUT",
      });
      const prices = await getGroupPackagePrices(group.id);
      expect(prices[0]!.package_price).toBe(800);
    });

    test("PUT is_package:false clears overrides", async () => {
      const group = await packagedGroup("Drop", 400);

      await apiRequest(`/api/admin/groups/${group.id}`, {
        body: { is_package: false },
        method: "PUT",
      });
      const prices = await getGroupPackagePrices(group.id);
      expect(prices[0]!.package_price).toBe(0);
    });

    test("PUT rejects a malformed package_members entry without wiping overrides", async () => {
      const group = await packagedGroup("FailClosed", 600);
      await assertJson(
        apiRequest(`/api/admin/groups/${group.id}`, {
          body: {
            is_package: true,
            package_members: [null],
          },
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toContain("package_members");
        },
      );
      // The existing override survives the rejected request.
      const prices = await getGroupPackagePrices(group.id);
      expect(prices[0]!.package_price).toBe(600);
    });

    test("PUT rejects is_package on an incompatible group", async () => {
      const group = await createTestGroup({ name: "BadPkg" });
      await createTestListing({ canPayMore: true, groupId: group.id });

      await assertJson(
        apiRequest(`/api/admin/groups/${group.id}`, {
          body: { is_package: true },
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toContain("Packages cannot contain");
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
