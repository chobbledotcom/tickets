import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { queryAll } from "#db/client.ts";
import { requireListingWithCount } from "#db/listings/records.ts";
import { t } from "#i18n";
import { assertJson, expectApiError } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  expectListingCreated,
  postListing,
  putListing,
} from "#test-utils/listing-api.ts";
import { apiRequest } from "#test-utils/session.ts";
import { MAX_DURATION_DAYS } from "#types";

describeWithEnv("Admin API - Listings", { db: true }, () => {
  describe("POST /api/admin/listings", () => {
    test("creates listing with required fields", async () => {
      await expectListingCreated(
        { max_attendees: 50, name: "New API Listing" },
        (listing) => {
          expect(listing.name).toBe("New API Listing");
          expect(listing.max_attendees).toBe(50);
          expect(listing.id).toBeGreaterThan(0);
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

    test("refuses out-of-range duration_days like the form does", async () => {
      // The declared range (1 to MAX_DURATION_DAYS) now applies to the JSON
      // API body, the same bounds the listing form enforces. The write's
      // column clamp stays as the storage backstop.
      for (const [durationDays, name] of [
        [5000, "API Refused High"],
        [-2, "API Refused Low"],
      ] as const) {
        await expectApiError(
          postListing({
            duration_days: durationDays,
            listing_type: "daily",
            max_attendees: 50,
            name,
          }),
          400,
          `duration_days must be a whole number from 1 to ${MAX_DURATION_DAYS}`,
        );
      }
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
        postListing({
          max_attendees: 10,
          name: "SSRF Attempt",
          webhook_url: "http://169.254.169.254/latest/meta-data",
        }),
        400,
        (body) => {
          assertStringIncludes(body.error, "Webhook URL");
        },
      );
    });

    test("rejects a fields list with an unknown contact field on create", async () => {
      await expectApiError(
        postListing({
          fields: "phone, e mail",
          max_attendees: 10,
          name: "Unknown Field",
        }),
        400,
        "fields has an invalid value",
      );
      expect(
        await queryAll("SELECT id FROM listings WHERE name = ?", [
          "Unknown Field",
        ]),
      ).toEqual([]);
    });

    test("stores padded contact fields as the trimmed tokens the parser reads", async () => {
      // The badge SQL compares whole stored tokens, so the write path stores
      // the parser's own read of the string: every token trims, blank ones
      // drop. A space- or non-breaking-space-padded "email" stores "email".
      const padded = [
        ["Padded Space Fields", " email ", "email"],
        ["Padded Narrow Fields", " email ", "email"],
        ["Padded List Fields", "phone ,\temail ", "phone,email"],
        ["Doubled Commas", "email,,phone", "email,phone"],
      ] as const;
      for (const [name, submitted, stored] of padded) {
        const created = await assertJson<{ listing: { id: number } }>(
          apiRequest("/api/admin/listings", {
            body: { fields: submitted, max_attendees: 10, name },
            method: "POST",
          }),
          201,
        );
        expect((await requireListingWithCount(created.listing.id)).fields).toBe(
          stored,
        );
      }
    });

    test("creates a customisable-days listing with day_prices", async () => {
      await expectListingCreated(
        {
          customisable_days: true,
          day_prices: { 1: 1000, 2: 1800 },
          duration_days: 3,
          max_attendees: 20,
          name: "Flexible Pass",
        },
        (listing) => {
          expect(listing.customisable_days).toBe(true);
          expect(listing.day_prices).toEqual({ 1: 1000, 2: 1800 });
        },
      );
    });

    test("refuses day prices with a bad day count or price", async () => {
      for (const dayPrices of [{ 0: 50 }, { x: 70 }, { 1: "nope" }]) {
        await expectApiError(
          postListing({
            customisable_days: true,
            day_prices: dayPrices,
            duration_days: 3,
            max_attendees: 20,
            name: "Bad Prices",
          }),
          400,
          "day_prices has an invalid value",
        );
      }
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

    const refusedCreates: [string, Record<string, unknown>, string][] = [
      [
        "returns 400 when name is missing",
        { max_attendees: 50 },
        "name is required",
      ],
      [
        "returns 400 when max_attendees is missing",
        { name: "No Max" },
        "max_attendees is required",
      ],
      [
        "validates group exists",
        { group_ids: [99999], max_attendees: 10, name: "Group Listing" },
        t("error.selected_group_deleted"),
      ],
    ];
    for (const [title, body, message] of refusedCreates) {
      test(title, async () => {
        await expectApiError(postListing(body), 400, message);
      });
    }

    test("returns 400 when name is longer than 250 characters", async () => {
      // The name travels to payment providers on the order ("Ticket: <name>"
      // at Square caps at 512), so a name beyond 250 must be refused rather
      // than stored and later fatal at checkout.
      await expectApiError(
        postListing({ max_attendees: 50, name: "N".repeat(251) }),
        400,
        "Name must be 250 characters or fewer",
      );
      await expectListingCreated({ max_attendees: 50, name: "N".repeat(250) });
    });

    test("returns 400 when max_attendees is zero", async () => {
      const response = await postListing({
        max_attendees: 0,
        name: "Zero Max",
      });

      expect(response.status).toBe(400);
    });

    test("validates can_pay_more requires sufficient max_price", async () => {
      await assertJson(
        postListing({
          can_pay_more: true,
          max_attendees: 10,
          max_price: 500,
          name: "Pay More Listing",
          unit_price: 500,
        }),
        400,
        (body) => {
          assertStringIncludes(body.error, "Maximum price");
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
          expect(body.listing).toMatchObject({
            active: true,
            closes_at: "2026-06-14T23:59:00.000Z",
            date: "2026-06-15T10:00:00.000Z",
          });
        },
      );
    });

    test("creates listing with empty name string returns error", async () => {
      await expectApiError(
        postListing({ max_attendees: 10, name: "   " }),
        400,
        "name cannot be empty",
      );
    });
  });

  describe("PUT /api/admin/listings/:listingId", () => {
    test("rejects a fields list with an unknown contact field on update", async () => {
      const created = await expectListingCreated({
        max_attendees: 10,
        name: "Field Update",
      });
      await expectApiError(
        putListing(created.listing.id, { fields: "emailx" }),
        400,
        "fields has an invalid value",
      );
    });

    test("stores an update's padded contact fields the way the parser reads them", async () => {
      const created = await expectListingCreated({
        max_attendees: 10,
        name: "Padded Update",
      });
      await assertJson(
        putListing(created.listing.id, { fields: " email " }),
        200,
      );
      expect((await requireListingWithCount(created.listing.id)).fields).toBe(
        "email",
      );
    });
  });
});
