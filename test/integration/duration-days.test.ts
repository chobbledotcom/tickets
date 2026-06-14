/**
 * Integration test for multi-day bookings (duration_days).
 *
 * Unit tests under test/lib/db/attendees/ already cover each layer —
 * this file exercises the one end-to-end path not reachable there: an
 * admin POST /admin/listing/:id/edit that changes duration and triggers
 * booking-range reconciliation.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createAttendeeAtomic } from "#shared/db/attendees.ts";
import { getDb } from "#shared/db/client.ts";
import { getListing } from "#shared/db/listings.ts";
import {
  createDailyTestListing,
  describeWithEnv,
  updateTestListing,
} from "#test-utils";

describeWithEnv("integration: duration_days", { db: true }, () => {
  describe("admin edit flow", () => {
    test("POST /admin/listing/:id/edit reconciles booking ranges when duration changes", async () => {
      const listing = await createDailyTestListing({
        maxAttendees: 10,
        maximumDaysAfter: 60,
      });
      await createAttendeeAtomic({
        bookings: [{ date: "2026-08-10", listingId: listing.id, quantity: 1 }],
        email: "edit@example.com",
        name: "Edit",
      });

      await updateTestListing(listing.id, { durationDays: 5 });

      const row = await getDb().execute({
        args: [listing.id],
        sql: "SELECT end_at FROM listing_attendees WHERE listing_id = ?",
      });
      expect(String(row.rows[0]!.end_at)).toBe("2026-08-15T00:00:00.000Z");

      const fresh = await getListing(listing.id);
      expect(fresh?.duration_days).toBe(5);
    });
  });
});
