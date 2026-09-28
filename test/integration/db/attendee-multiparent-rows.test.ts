import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeesApi } from "#db/attendees/api.ts";
import { expandChildAllocations } from "#db/attendees/order-parents.ts";
import { moveTickets } from "#db/attendees/update.ts";
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

    /** The admitted count on each per-parent row, in parent order. */
    const countsFor = async (attendeeId: number, listingId: number) =>
      (await rowsFor(attendeeId, listingId)).map((r) => Number(r.checked_in));

    test("admitting one ticket moves one ticket across the per-parent rows", async () => {
      const { attendee, child } = await bookChildUnderTwoParents();
      const move = { attendeeId: attendee.id, count: 1, listingId: child.id };

      expect(await moveTickets("admit", [move])).toEqual([move]);
      expect(await countsFor(attendee.id, child.id)).toEqual([1, 0]);

      await moveTickets("admit", [move]);
      expect(await countsFor(attendee.id, child.id)).toEqual([1, 1]);

      // Both rows are full, so a third ticket has nowhere to go.
      expect(await moveTickets("admit", [move])).toEqual([
        { ...move, count: 0 },
      ]);
    });

    test("releasing one ticket moves one ticket across the per-parent rows", async () => {
      const { attendee, child } = await bookChildUnderTwoParents();
      const move = { attendeeId: attendee.id, listingId: child.id };
      await moveTickets("admit", [{ ...move, count: 2 }]);

      await moveTickets("release", [{ ...move, count: 1 }]);
      expect(await countsFor(attendee.id, child.id)).toEqual([0, 1]);
    });
  },
);
