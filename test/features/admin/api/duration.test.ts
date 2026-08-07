import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { apiRequest } from "#test-utils/session.ts";

describeWithEnv("Admin API listing duration", { db: true }, () => {
  describe("PUT /api/admin/listings/:listingId", () => {
    test("updates duration_days", async () => {
      const listing = await createDailyTestListing({ maxAttendees: 10 });

      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: { duration_days: 7 },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.listing.duration_days).toBe(7);
        },
      );
    });

    test("preserves duration_days when omitted", async () => {
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
        (body) => {
          expect(body.listing.name).toBe("Renamed");
          expect(body.listing.duration_days).toBe(5);
        },
      );
    });

    test("returns 400 for a fractional duration", async () => {
      const listing = await createTestListing({ name: "Whole Days" });
      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: { duration_days: 2.5 },
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toBe("duration_days must be a safe integer");
        },
      );
    });
  });
});
