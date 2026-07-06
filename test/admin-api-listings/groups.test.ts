import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getGroupIdsByListingId } from "#shared/db/groups.ts";
import {
  apiRequest,
  assertJson,
  createTestGroup,
  describeWithEnv,
} from "#test-utils";

describeWithEnv("Admin API - Listings", { db: true }, () => {
  describe("POST /api/admin/listings - group validation", () => {
    test("creates listing in a valid group", async () => {
      const group = await createTestGroup({ name: "Valid Group" });

      const body = await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            group_ids: [group.id],
            listing_type: "standard",
            max_attendees: 10,
            name: "Grouped Listing",
          },
          method: "POST",
        }),
        201,
      );
      expect(await getGroupIdsByListingId(body.listing.id)).toEqual([group.id]);
    });

    test("creates a default-standard listing in an existing group without listing_type", async () => {
      const group = await createTestGroup({ name: "Standard Group" });
      // Seed the group with one standard listing.
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            group_ids: [group.id],
            listing_type: "standard",
            max_attendees: 10,
            name: "First",
          },
          method: "POST",
        }),
        201,
      );
      // A second create omits listing_type (DB defaults to standard); it must
      // not be read as a type mismatch against the standard group.
      const body = await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            group_ids: [group.id],
            max_attendees: 10,
            name: "Second",
          },
          method: "POST",
        }),
        201,
      );
      expect(await getGroupIdsByListingId(body.listing.id)).toEqual([group.id]);
    });

    test("listing responses include group_ids so clients can round-trip them", async () => {
      const group = await createTestGroup({ name: "Roundtrip Group" });
      const created = await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            group_ids: [group.id],
            max_attendees: 10,
            name: "Roundtrip Listing",
          },
          method: "POST",
        }),
        201,
      );
      // Membership is readable from the create, get, and list responses.
      expect(created.listing.group_ids).toEqual([group.id]);
      const got = await assertJson(
        apiRequest(`/api/admin/listings/${created.listing.id}`),
        200,
      );
      expect(got.listing.group_ids).toEqual([group.id]);
      const list = await assertJson(apiRequest("/api/admin/listings"), 200);
      const inList = list.listings.find(
        (l: { id: number }) => l.id === created.listing.id,
      );
      expect(inList.group_ids).toEqual([group.id]);
    });

    test("list batch-hydrates group_ids, including an empty array for ungrouped", async () => {
      const group = await createTestGroup({ name: "Batch Group" });
      const grouped = await assertJson(
        apiRequest("/api/admin/listings", {
          body: { group_ids: [group.id], max_attendees: 10, name: "Grouped" },
          method: "POST",
        }),
        201,
      );
      const ungrouped = await assertJson(
        apiRequest("/api/admin/listings", {
          body: { max_attendees: 10, name: "Ungrouped" },
          method: "POST",
        }),
        201,
      );

      const list = await assertJson(apiRequest("/api/admin/listings"), 200);
      const byId = new Map<number, { group_ids: number[] }>(
        list.listings.map((l: { id: number }) => [l.id, l]),
      );
      expect(byId.get(grouped.listing.id)?.group_ids).toEqual([group.id]);
      // An ungrouped listing hydrates to an empty array, not a missing field.
      expect(byId.get(ungrouped.listing.id)?.group_ids).toEqual([]);
    });

    test("PUT moves a listing from one group to another", async () => {
      const groupA = await createTestGroup({ name: "From Group" });
      const groupB = await createTestGroup({ name: "To Group" });
      const created = await assertJson(
        apiRequest("/api/admin/listings", {
          body: { group_ids: [groupA.id], max_attendees: 10, name: "Mover" },
          method: "POST",
        }),
        201,
      );
      expect(await getGroupIdsByListingId(created.listing.id)).toEqual([
        groupA.id,
      ]);

      // Re-grouping a listing that already belongs to a group diffs the current
      // membership against the new set inside the write transaction.
      const updated = await assertJson(
        apiRequest(`/api/admin/listings/${created.listing.id}`, {
          body: { group_ids: [groupB.id] },
          method: "PUT",
        }),
        200,
      );
      expect(updated.listing.group_ids).toEqual([groupB.id]);
      expect(await getGroupIdsByListingId(created.listing.id)).toEqual([
        groupB.id,
      ]);
    });

    test("rejects listing with mismatched type in group", async () => {
      const group = await createTestGroup({ name: "Type Group" });

      // Create a standard listing in the group
      await apiRequest("/api/admin/listings", {
        body: {
          group_ids: [group.id],
          listing_type: "standard",
          max_attendees: 10,
          name: "Standard In Group",
        },
        method: "POST",
      });

      // Try to create a daily listing in the same group
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            group_ids: [group.id],
            listing_type: "daily",
            max_attendees: 10,
            name: "Daily In Group",
          },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toContain("same type");
        },
      );
    });

    test("can_pay_more with valid max_price passes validation", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            can_pay_more: true,
            max_attendees: 10,
            max_price: 700,
            name: "Pay More Valid",
            unit_price: 500,
          },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.listing.can_pay_more).toBe(true);
        },
      );
    });

    test("can_pay_more without unit_price passes validation", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            can_pay_more: true,
            max_attendees: 10,
            max_price: 200,
            name: "Free Pay More",
          },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.listing.can_pay_more).toBe(true);
        },
      );
    });
  });
});
