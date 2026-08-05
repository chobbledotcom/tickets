import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { listingGroups } from "#shared/db/groups.ts";
import { requireListingWithCount } from "#shared/db/listings/records.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { storedListingNames } from "#test-utils/db-helpers/listings.ts";
import { apiRequest } from "#test-utils/session.ts";

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
      expect(await listingGroups.getIds(body.listing.id)).toEqual([group.id]);
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
      expect(await listingGroups.getIds(body.listing.id)).toEqual([group.id]);
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

    test("deactivating and reactivating answer with group_ids too", async () => {
      const group = await createTestGroup({ name: "Toggle Group" });
      const created = await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            group_ids: [group.id],
            max_attendees: 10,
            name: "Toggle Listing",
          },
          method: "POST",
        }),
        201,
      );

      const deactivated = await assertJson(
        apiRequest(`/api/admin/listings/${created.listing.id}/deactivate`, {
          method: "POST",
        }),
        200,
      );
      expect(deactivated.listing.group_ids).toEqual([group.id]);

      const reactivated = await assertJson(
        apiRequest(`/api/admin/listings/${created.listing.id}/reactivate`, {
          method: "POST",
        }),
        200,
      );
      expect(reactivated.listing.group_ids).toEqual([group.id]);
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
      expect(await listingGroups.getIds(created.listing.id)).toEqual([
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
      expect(await listingGroups.getIds(created.listing.id)).toEqual([
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

    test("rejects a customisable-days listing created into a fixed-length group", async () => {
      const group = await createTestGroup({ name: "Fixed Length Group" });
      await apiRequest("/api/admin/listings", {
        body: {
          group_ids: [group.id],
          listing_type: "daily",
          max_attendees: 10,
          name: "Fixed Length Member",
        },
        method: "POST",
      });

      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            customisable_days: true,
            day_prices: { 1: 100 },
            group_ids: [group.id],
            listing_type: "daily",
            max_attendees: 10,
            name: "Customisable Candidate",
          },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toContain(
            "already contains listings with a fixed number of days",
          );
        },
      );

      // A refused create leaves nothing behind.
      expect(await storedListingNames()).not.toContain(
        "Customisable Candidate",
      );
    });

    test("rejects flipping a grouped listing's type when the update leaves membership alone", async () => {
      const group = await createTestGroup({ name: "Type Fold Group" });
      // A second member, so the flip would genuinely mix the group's types —
      // a group's only member can always flip without mixing anything.
      await apiRequest("/api/admin/listings", {
        body: {
          group_ids: [group.id],
          listing_type: "standard",
          max_attendees: 10,
          name: "Standard Sibling",
        },
        method: "POST",
      });
      const created = await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            group_ids: [group.id],
            listing_type: "standard",
            max_attendees: 10,
            name: "Folded In",
          },
          method: "POST",
        }),
        201,
      );

      // The update omits group_ids, so the listing would keep its membership:
      // the flip alone would leave it in a group of the other type.
      await assertJson(
        apiRequest(`/api/admin/listings/${created.listing.id}`, {
          body: { listing_type: "daily" },
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toContain("same type");
        },
      );

      expect(await listingGroups.getIds(created.listing.id)).toEqual([
        group.id,
      ]);
      expect(
        (await requireListingWithCount(created.listing.id)).listing_type,
      ).toBe("standard");
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
