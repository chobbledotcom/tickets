/**
 * Which listing a refused creation names. A capacity failure carries the ids
 * of the lines that did not fit, read back after the refused write, so a
 * caller can name the true culprit instead of the order's first listing.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeesApi } from "#db/attendees/api.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";

const FULL_DAY = "2026-10-01";

describeWithEnv(
  "db > a refused creation names the listing out of room",
  { db: true },
  () => {
    /** A roomy standard listing beside a daily one whose single place on
     * FULL_DAY is already taken. */
    const roomyAndFullDaily = async () => {
      const roomy = await createTestListing({ maxAttendees: 10 });
      const daily = await createDailyTestListing({
        maxAttendees: 1,
        maximumDaysAfter: 60,
      });
      const taken = await attendeesApi.createAttendeeAtomic({
        bookings: [{ date: FULL_DAY, listingId: daily.id, quantity: 1 }],
        email: "first@example.com",
        name: "First",
      });
      if (!taken.success) throw new Error("Setup: the day did not book");
      return { daily, roomy };
    };

    test("a failed later line is the one named, not the first line", async () => {
      const { daily, roomy } = await roomyAndFullDaily();

      const result = await attendeesApi.createAttendeeAtomic({
        bookings: [
          { listingId: roomy.id, quantity: 1 },
          { date: FULL_DAY, listingId: daily.id, quantity: 1 },
        ],
        email: "late@example.com",
        name: "Late",
      });

      expect(result).toEqual({
        listingIds: [daily.id],
        reason: "capacity_exceeded",
        success: false,
      });
      // The refusal left nothing behind on the line that would have fit.
      expect((await getAttendeesRaw(roomy.id)).length).toBe(0);
    });
  },
);
