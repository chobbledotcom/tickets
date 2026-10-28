import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeeRaw } from "#db/attendees/queries.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createBooking,
  rosterAttendeeIds,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv(
  "Admin API - POST /api/admin/attendees accepts a created instant",
  { db: true },
  () => {
    test("stores a caller-supplied created instant and reads it back", async () => {
      const listing = await createTestListing({ name: "Historic Fair" });
      const created = await assertJson(
        createBooking(listing.id, {
          created: "2026-09-01T09:00:00Z",
          name: "Historic Buyer",
        }),
        201,
        (body) =>
          expect(body.attendee.created).toBe("2026-09-01T09:00:00.000Z"),
      );
      // At rest the row carries the caller's business time, so reports that
      // read the database see the phone-booking day, not the entry time.
      const stored = await getAttendeeRaw(created.attendee.id as number);
      expect(stored!.created).toBe("2026-09-01T09:00:00.000Z");
    });

    test("normalises an offset created instant to the canonical UTC form", async () => {
      const listing = await createTestListing({ name: "Offset Fair" });
      const created = await assertJson(
        createBooking(listing.id, {
          created: "2026-09-01T11:00:00+02:00",
          name: "Offset Buyer",
        }),
        201,
      );
      expect(created.attendee.created).toBe("2026-09-01T09:00:00.000Z");
    });

    test("a historical created sits at the right place in the roster's date order", async () => {
      const listing = await createTestListing({ name: "Ordered Fair" });
      // The roster answers newest first by created, so a booking stamped with
      // an earlier business time lists after one stamped now.
      const old = await assertJson(
        createBooking(listing.id, {
          created: "2026-09-01T09:00:00Z",
          name: "Old Buyer",
        }),
        201,
      );
      const fresh = await assertJson(
        createBooking(listing.id, { name: "New Buyer" }),
        201,
      );
      expect(await rosterAttendeeIds(listing.id)).toEqual([
        fresh.attendee.id,
        old.attendee.id,
      ]);
    });

    test("an omitted created stamps the current time", async () => {
      const listing = await createTestListing({ name: "Now Fair" });
      const before = Date.now();
      const created = await assertJson(createBooking(listing.id), 201);
      const after = Date.now();
      const stamped = new Date(created.attendee.created).getTime();
      expect(stamped).toBeGreaterThanOrEqual(before - 1000);
      expect(stamped).toBeLessThanOrEqual(after + 1000);
    });
  },
);
