import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getListingWithCount } from "#db/listings/records.ts";
import {
  handleListingRecalculateGet,
  handleListingRecalculatePost,
} from "#routes/admin/listings-recalculate.ts";
import { RECALCULATE_FIELD_NAME } from "#shared/recalculate-fields.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createListingWithDriftedTotals } from "#test-utils/db-helpers/listings.ts";
import { mockFormRequest, mockRequest } from "#test-utils/mocks.ts";
import { getTestSession } from "#test-utils/session.ts";

const recalculatePath = (listingId: number): string =>
  `/admin/listings/recalculate/${listingId}`;

describeWithEnv("admin listing recalculate routes", { db: true }, () => {
  describe("GET", () => {
    test("shows the stored totals beside the recounted ones", async () => {
      const listing = await createListingWithDriftedTotals();
      const { cookie } = await getTestSession();

      const response = await handleListingRecalculateGet(
        mockRequest(recalculatePath(listing.id), { headers: { cookie } }),
        { listingId: listing.id },
      );

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Current");
      expect(html).toContain("From attendee data");
      // Stored 9 and 5 beside the one booking's 1 and 1, or the operator
      // cannot see what they are about to change.
      expect(html).toContain("<td>9</td><td>1</td>");
      expect(html).toContain("<td>5</td><td>1</td>");
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
      const listing = await createListingWithDriftedTotals();
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
      const listing = await createListingWithDriftedTotals();
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
      const listing = await createListingWithDriftedTotals();
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
