import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { MAX_DURATION_DAYS } from "#shared/types.ts";
import { assertJson, fetchListingExportCsv } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createDailyTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest, mockFormRequest } from "#test-utils/mocks.ts";
import { apiRequest, setupListingAndLogin } from "#test-utils/session.ts";

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

  describe("admin CSV export via HTTP", () => {
    test("GET /admin/listing/:id/export includes date range for multi-day", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        durationDays: 3,
        listingType: "daily",
        maximumDaysAfter: 60,
        minimumDaysBefore: 0,
      });
      await bookAttendee(listing, { date: "2026-06-12", durationDays: 3 });

      const csv = await fetchListingExportCsv(listing.id, cookie);
      expect(csv).toContain("2026-06-12 to 2026-06-14");
    });
  });

  describe("admin attendee detail page", () => {
    test("shows date range for multi-day booking in listing links table", async () => {
      const listing = await createDailyTestListing({
        durationDays: 3,
        maxAttendees: 10,
      });
      const result = await bookAttendee(listing, {
        date: "2026-07-15",
        durationDays: 3,
      });
      if (!result.success) throw new Error("setup");

      const { cookie } = await setupListingAndLogin();
      const response = await awaitTestRequest(
        `/admin/attendees/${result.attendees[0]!.id}`,
        { cookie },
      );
      const html = await response.text();
      // Should show the range label, not just the start date.
      expect(html).toContain("15");
      expect(html).toContain("17");
      expect(html).toContain("July");
    });
  });

  describe("admin attendee check-in on multi-day booking", () => {
    test("check-in works for attendee with multi-day booking", async () => {
      const { handleRequest } = await import("#routes");
      const { listing, cookie, csrfToken } = await setupListingAndLogin({
        durationDays: 3,
        listingType: "daily",
        maxAttendees: 10,
        maximumDaysAfter: 60,
        minimumDaysBefore: 0,
      });
      const result = await bookAttendee(listing, {
        date: "2026-08-01",
        durationDays: 3,
      });
      if (!result.success) throw new Error("setup");

      const response = await handleRequest(
        mockFormRequest(
          `/admin/listing/${listing.id}/attendee/${
            result.attendees[0]!.id
          }/checkin`,
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(302);

      const attendees = await getAttendeesRaw(listing.id);
      const checkedIn = attendees.find((a) => a.id === result.attendees[0]!.id);
      expect(Boolean(checkedIn?.checked_in)).toBe(true);
    });
  });
});
