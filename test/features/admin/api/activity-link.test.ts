import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAllActivityLog } from "#db/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { apiRequest, withTestSession } from "#test-utils/session.ts";

describeWithEnv(
  "Admin API - Listings - activity links",
  {
    db: true,
  },
  () => {
    test("an update links its activity log row to the listing it changed", async () => {
      const listing = await createTestListing({ name: "Linked Camp" });
      await apiRequest(`/api/admin/listings/${listing.id}`, {
        body: { name: "Linked Camp Two" },
        method: "PUT",
      });

      // Reading the log needs the owner's private key from the test session.
      const entry = await withTestSession(async () =>
        (await getAllActivityLog()).find(
          (log) => log.message === "Listing 'Linked Camp Two' updated",
        ),
      );
      expect(entry?.listing_id).toBe(listing.id);
      expect(entry?.attendee_id).toBeNull();
    });
  },
);
