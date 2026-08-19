import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { queryAll } from "#db/client.ts";
import { requireListingWithCount } from "#db/listings/records.ts";
import { t } from "#i18n";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { apiRequest } from "#test-utils/session.ts";
import { MAX_DURATION_DAYS } from "#types";

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

    test("clamps out-of-range duration_days to the supported bounds", async () => {
      // The JSON API has no form layer, so the column-level clamp is all that
      // bounds duration_days (each day adds a clause to the atomic capacity
      // SQL, so an unbounded value is a perf hazard). The response echoes the
      // clamped value, and the clamp is what is stored.
      const high = await assertJson<{
        listing: { id: number; duration_days: number };
      }>(
        apiRequest("/api/admin/listings", {
          body: {
            duration_days: 5000,
            listing_type: "daily",
            max_attendees: 50,
            name: "API Clamped High",
          },
          method: "POST",
        }),
        201,
      );
      expect(high.listing.duration_days).toBe(MAX_DURATION_DAYS);
      expect(
        (await requireListingWithCount(high.listing.id)).duration_days,
      ).toBe(MAX_DURATION_DAYS);
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            duration_days: -2,
            listing_type: "daily",
            max_attendees: 50,
            name: "API Clamped Low",
          },
          method: "POST",
        }),
        201,
        (body: { listing: { duration_days: number } }) => {
          expect(body.listing.duration_days).toBe(1);
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
          expect(body.error).toBe(t("error.selected_group_deleted"));
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
});
