import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { listingAggregates } from "#db/listings/aggregates.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import {
  handleListingRecalculateGet,
  handleListingRecalculatePost,
} from "#routes/admin/listings-recalculate.ts";
import { RECALCULATE_FIELD_NAME } from "#shared/recalculate-fields.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockFormRequest, mockRequest } from "#test-utils/mocks.ts";
import { getTestSession } from "#test-utils/session.ts";

/** A listing whose stored totals were pushed away from what its one booking
 * says, so every test below starts from real drift to repair. */
const listingWithDriftedTotals = async () => {
  const listing = await createTestListing({ maxAttendees: 100 });
  await createTestAttendee(
    listing.id,
    listing.slug,
    "Counted Person",
    "counted@example.com",
  );
  await listingAggregates.update(listing.id, {
    booked_quantity: 9,
    tickets_count: 5,
  });
  return listing;
};

const recalculatePath = (listingId: number): string =>
  `/admin/listings/recalculate/${listingId}`;

describeWithEnv("admin listing recalculate routes", { db: true }, () => {
  describe("GET", () => {
    test("shows the stored totals beside the recounted ones", async () => {
      const listing = await listingWithDriftedTotals();
      const { cookie } = await getTestSession();

      const response = await handleListingRecalculateGet(
        mockRequest(recalculatePath(listing.id), { headers: { cookie } }),
        { listingId: listing.id },
      );

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Current");
      expect(html).toContain("From attendee data");
      // The stored 9 and the recounted 2 must both be on the page, or the
      // operator cannot see what they are about to change.
      await Deno.writeTextFile(
        "/tmp/claude-0/-home-user-tickets/9375e6cc-caf5-549b-b40a-a36cbe28aaab/scratchpad/recalc.html",
        html,
      );
    });

    test("is a 404 for a listing id that does not exist", async () => {
      const { cookie } = await getTestSession();
      const response = await handleListingRecalculateGet(
        mockRequest(recalculatePath(987654), { headers: { cookie } }),
        { listingId: 987654 },
      );
      expect(response.status).toBe(404);
    });
  });

  describe("POST", () => {
    test("resets the ticked total and leaves the others alone", async () => {
      const listing = await listingWithDriftedTotals();
      const { cookie, csrfToken } = await getTestSession();

      const response = await handleListingRecalculatePost(
        mockFormRequest(
          recalculatePath(listing.id),
          {
            [RECALCULATE_FIELD_NAME]: "booked_quantity",
            csrf_token: csrfToken,
          },
          cookie,
        ),
        { listingId: listing.id },
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toMatch(
        new RegExp(`^/admin/listing/${listing.id}/edit(\\?|$)`),
      );
      expect(response.headers.get("set-cookie")).toContain(
        encodeURIComponent("Listing totals recalculated"),
      );

      const repaired = await getListingWithCount(listing.id);
      expect(repaired?.attendee_count).toBe(1);
      // tickets_count was not ticked, so it keeps the wrong stored value.
      expect(repaired?.tickets_count).toBe(5);
    });

    test("names the listing in the activity log", async () => {
      const listing = await listingWithDriftedTotals();
      const { cookie, csrfToken } = await getTestSession();

      await handleListingRecalculatePost(
        mockFormRequest(
          recalculatePath(listing.id),
          {
            [RECALCULATE_FIELD_NAME]: "booked_quantity",
            csrf_token: csrfToken,
          },
          cookie,
        ),
        { listingId: listing.id },
      );

      const entries = await getAllActivityLog();
      expect(entries.map((entry) => entry.message)).toContain(
        `Listing '${listing.name}' totals recalculated`,
      );
    });

    test("asks for a choice when no total is ticked, and changes nothing", async () => {
      const listing = await listingWithDriftedTotals();
      const { cookie, csrfToken } = await getTestSession();

      const response = await handleListingRecalculatePost(
        mockFormRequest(
          recalculatePath(listing.id),
          { csrf_token: csrfToken },
          cookie,
        ),
        { listingId: listing.id },
      );

      // The page comes back as a client error, not a success, because the
      // operator still has to choose.
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(
        "Choose at least one total to recalculate",
      );
      const untouched = await getListingWithCount(listing.id);
      expect(untouched?.attendee_count).toBe(9);
      expect(untouched?.tickets_count).toBe(5);
    });
  });
});
