import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { MAX_DURATION_DAYS } from "#shared/types.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createDailyTestListing } from "#test-utils/db-helpers/listings.ts";
import { apiRequest } from "#test-utils/session.ts";

describeWithEnv("e2e: multi-day bookings — API & HTTP", { db: true }, () => {
  describe("admin REST API", () => {
    test("POST /api/admin/listings creates listing with duration_days", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            duration_days: 3,
            listing_type: "daily",
            max_attendees: 50,
            name: "API Multi-Day",
          },
          method: "POST",
        }),
        201,
        (body: {
          listing: { duration_days: number; listing_type: string };
        }) => {
          expect(body.listing.duration_days).toBe(3);
          expect(body.listing.listing_type).toBe("daily");
        },
      );
    });

    test("PUT /api/admin/listings/:id updates duration_days", async () => {
      const listing = await createDailyTestListing({ maxAttendees: 10 });
      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: { duration_days: 7 },
          method: "PUT",
        }),
        200,
        (body: { listing: { duration_days: number } }) => {
          expect(body.listing.duration_days).toBe(7);
        },
      );
    });

    test("PUT /api/admin/listings/:id preserves duration_days when omitted", async () => {
      const listing = await createDailyTestListing({
        durationDays: 5,
        maxAttendees: 10,
      });
      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: { name: "Renamed" },
          method: "PUT",
        }),
        200,
        (body: { listing: { duration_days: number; name: string } }) => {
          expect(body.listing.name).toBe("Renamed");
          expect(body.listing.duration_days).toBe(5);
        },
      );
    });

    test("POST /api/admin/listings clamps out-of-range duration_days", async () => {
      // The admin form validates 1-90, but the JSON API has no form layer —
      // the column-level clamp must bound it (each day adds a clause to the
      // atomic capacity SQL, so an unbounded value is a perf hazard).
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
      const stored = await getListingWithCount(high.listing.id);
      expect(stored?.duration_days).toBe(MAX_DURATION_DAYS);
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
  });
});
