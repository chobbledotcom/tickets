import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeesApi } from "#db/attendees/api.ts";
import { expandChildAllocations } from "#db/attendees/order-parents.ts";
import { updateCheckedIn } from "#db/attendees/update.ts";
import { queryAll } from "#db/client.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** The persisted rows for one listing under one attendee, with their parent. */
const rowsFor = (attendeeId: number, listingId: number) =>
  queryAll<{ parent_listing_id: number; checked_in: number; quantity: number }>(
    `SELECT parent_listing_id, checked_in, quantity FROM listing_attendees
      WHERE attendee_id = ? AND listing_id = ? ORDER BY parent_listing_id`,
    [attendeeId, listingId],
  );

describeWithEnv(
  "db > attendees > multi-parent booking rows",
  { db: true },
  () => {
    /** A child gated by two parents, booked once under each in one order — the
     * expansion the widened `(listing_id, attendee_id, start_at,
     * parent_listing_id)` index keeps as two faithful per-parent rows. */
    const bookChildUnderTwoParents = async () => {
      const parentA = await createTestListing({ name: "Base A" });
      const parentB = await createTestListing({ name: "Base B" });
      const child = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 10,
        name: "Shared add-on",
      });
      await listingChildren.setIds(parentA.id, [child.id]);
      await listingChildren.setIds(parentB.id, [child.id]);

      const bookings = expandChildAllocations(
        [
          { listingId: parentA.id, quantity: 1 },
          { listingId: parentB.id, quantity: 1 },
          { listingId: child.id, quantity: 2 },
        ],
        [
          { childId: child.id, parentId: parentA.id, qty: 1 },
          { childId: child.id, parentId: parentB.id, qty: 1 },
        ],
      );
      const result = await attendeesApi.createAttendeeAtomic({
        bookings,
        email: "multi@example.com",
        name: "Multi Parent",
      });
      if (!result.success) throw new Error(`setup failed: ${result.reason}`);
      return { attendee: result.attendees[0]!, child, parentA, parentB };
    };

    test("the same child under two parents persists as two distinct rows", async () => {
      const { attendee, child, parentA, parentB } =
        await bookChildUnderTwoParents();
      const rows = await rowsFor(attendee.id, child.id);
      // Two rows, one per parent — not collapsed into one.
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => Number(r.parent_listing_id))).toEqual(
        [parentA.id, parentB.id].sort((a, b) => a - b),
      );
      expect(rows.every((r) => Number(r.quantity) === 1)).toBe(true);
    });

    test("check-in flips every per-parent row of a listing together", async () => {
      const { attendee, child } = await bookChildUnderTwoParents();
      await updateCheckedIn(attendee.id, child.id, true);
      const checkedIn = await rowsFor(attendee.id, child.id);
      // updateCheckedIn keys on (attendee, listing), so BOTH per-parent rows
      // flip — the wholesale semantic, consistent with a single quantity>1 row.
      expect(checkedIn.every((r) => Number(r.checked_in) === 1)).toBe(true);
      await updateCheckedIn(attendee.id, child.id, false);
      const checkedOut = await rowsFor(attendee.id, child.id);
      expect(checkedOut.every((r) => Number(r.checked_in) === 0)).toBe(true);
    });
  },
);
