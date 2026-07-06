import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { queryAll } from "#shared/db/client.ts";
import { getGroupIdsByListingId } from "#shared/db/groups.ts";
import {
  apiRequest,
  assertJson,
  createTestGroup,
  describeWithEnv,
} from "#test-utils";

describeWithEnv("Admin API - Listings", { db: true }, () => {
  describe("POST /api/admin/listings", () => {
    test("creates listing with required fields", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            max_attendees: 50,
            name: "New API Listing",
          },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.listing.name).toBe("New API Listing");
          expect(body.listing.max_attendees).toBe(50);
          expect(body.listing.id).toBeGreaterThan(0);
          expect(body.listing.slug_index).toBeUndefined();
        },
      );
    });

    test("persists duration_days for daily listings", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            duration_days: 3,
            listing_type: "daily",
            max_attendees: 20,
            name: "Multi-day Workshop",
          },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.listing.duration_days).toBe(3);
          expect(body.listing.listing_type).toBe("daily");
        },
      );
    });

    test("defaults duration_days to 1 when omitted", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            listing_type: "daily",
            max_attendees: 20,
            name: "Single-day Workshop",
          },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.listing.duration_days).toBe(1);
        },
      );
    });

    test("creates listing with all optional fields", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            bookable_days: ["Monday", "Tuesday"],
            can_pay_more: true,
            description: "A test listing",
            fields: "email,phone",
            hidden: false,
            listing_type: "standard",
            location: "Test Hall",
            max_attendees: 100,
            max_price: 1000,
            max_quantity: 5,
            maximum_days_after: 60,
            minimum_days_before: 2,
            name: "Full Listing",
            non_transferable: true,
            thank_you_url: "https://example.com/thanks",
            unit_price: 500,
            webhook_url: "https://example.com/webhook",
          },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.listing.name).toBe("Full Listing");
          expect(body.listing.description).toBe("A test listing");
          expect(body.listing.location).toBe("Test Hall");
          expect(body.listing.unit_price).toBe(500);
          expect(body.listing.max_quantity).toBe(5);
          expect(body.listing.max_price).toBe(1000);
          expect(body.listing.non_transferable).toBe(true);
          expect(body.listing.can_pay_more).toBe(true);
          expect(body.listing.hidden).toBe(false);
        },
      );
    });

    test("rejects an unsafe (internal) webhook_url (SSRF guard)", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            max_attendees: 10,
            name: "SSRF Attempt",
            webhook_url: "http://169.254.169.254/latest/meta-data",
          },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toContain("Webhook URL");
        },
      );
    });

    test("creates a customisable-days listing with day_prices", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            customisable_days: true,
            // Mixed entries: day<1, non-integer key, and a non-numeric value
            // are all dropped by the parser.
            day_prices: { 0: 50, 1: 1000, 2: 1800, 3: "nope", x: 70 },
            duration_days: 3,
            max_attendees: 20,
            name: "Flexible Pass",
          },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.listing.customisable_days).toBe(true);
          expect(body.listing.day_prices).toEqual({ 1: 1000, 2: 1800 });
        },
      );
    });

    test("syncs listing_prices on the transactional API create path", async () => {
      // The API create goes through the crud-api sideEffect (child-edge) path,
      // which uses insertStatement and so bypasses the listingsTable wrapper;
      // the afterWrite hook must still reconcile listing_prices.
      const response = await apiRequest("/api/admin/listings", {
        body: {
          customisable_days: true,
          day_prices: { 1: 1000, 2: 1800 },
          duration_days: 2,
          max_attendees: 20,
          name: "API Priced",
          unit_price: 900,
        },
        method: "POST",
      });
      const { listing } = await response.json();
      const rows = await queryAll(
        `SELECT price_type, price_id, unit_price FROM listing_prices
          WHERE listing_id = ? ORDER BY price_type, price_id`,
        [listing.id],
      );
      expect(rows).toEqual([
        { price_id: "", price_type: "base", unit_price: 900 },
        { price_id: "1", price_type: "day_count", unit_price: 1000 },
        { price_id: "2", price_type: "day_count", unit_price: 1800 },
      ]);
    });

    test("returns 400 when name is missing", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: { max_attendees: 50 },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe("name is required");
        },
      );
    });

    test("returns 400 when max_attendees is missing", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: { name: "No Max" },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe("max_attendees is required and must be >= 1");
        },
      );
    });

    test("returns 400 when max_attendees is zero", async () => {
      const response = await apiRequest("/api/admin/listings", {
        body: { max_attendees: 0, name: "Zero Max" },
        method: "POST",
      });

      expect(response.status).toBe(400);
    });

    test("validates can_pay_more requires sufficient max_price", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            can_pay_more: true,
            max_attendees: 10,
            max_price: 500,
            name: "Pay More Listing",
            unit_price: 500,
          },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toContain("Maximum price");
        },
      );
    });

    test("validates group exists", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            group_ids: [99999],
            max_attendees: 10,
            name: "Group Listing",
          },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe("Selected group does not exist");
        },
      );
    });
  });

  describe("POST /api/admin/listings - date and closes_at handling", () => {
    test("creates listing with date and closes_at", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            active: true,
            closes_at: "2026-06-14T23:59:00Z",
            date: "2026-06-15T10:00:00Z",
            max_attendees: 20,
            name: "Dated Listing",
          },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.listing.date).toBe("2026-06-15T10:00:00.000Z");
          expect(body.listing.closes_at).toBe("2026-06-14T23:59:00.000Z");
          expect(body.listing.active).toBe(true);
        },
      );
    });

    test("creates listing with empty name string returns error", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: { max_attendees: 10, name: "   " },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe("name is required");
        },
      );
    });
  });

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
