import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeesApi } from "#db/attendees/api.ts";
import { expandChildAllocations } from "#db/attendees/order-parents.ts";
import { moveTickets } from "#db/attendees/update.ts";
import { getDb, queryAll } from "#db/client.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { reverseOrderFor } from "#test/shared/db/attendees/select-refunded/support.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";

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

      expect(await moveTickets("admit", [move])).toEqual([
        { ...move, owedAfter: 1 },
      ]);
      expect(await countsFor(attendee.id, child.id)).toEqual([1, 0]);

      await moveTickets("admit", [move]);
      expect(await countsFor(attendee.id, child.id)).toEqual([1, 1]);

      // Both rows are full, so a third ticket has nowhere to go.
      expect(await moveTickets("admit", [move])).toEqual([
        { ...move, count: 0, owedAfter: 0 },
      ]);
    });

    test("releasing one ticket moves one ticket across the per-parent rows", async () => {
      const { attendee, child } = await bookChildUnderTwoParents();
      const move = { attendeeId: attendee.id, listingId: child.id };
      await moveTickets("admit", [{ ...move, count: 2 }]);

      await moveTickets("release", [{ ...move, count: 1 }]);
      expect(await countsFor(attendee.id, child.id)).toEqual([0, 1]);
    });

    test("a refunded sibling row never takes the tickets a live row owes", async () => {
      const { attendee, child, parentB } = await bookChildUnderTwoParents();
      // Two separate paid orders, one per row — the row shape a person
      // merged from two bookings on one listing holds. postListingSale
      // stamps every un-stamped row, so both rows land on the first order;
      // point the second row at its own order to give each row one.
      const firstOrder = await postListingSale({
        attendeeId: attendee.id,
        eventId: "order-a",
        gross: 100,
        listingId: child.id,
      });
      const secondOrder = await postListingSale({
        attendeeId: attendee.id,
        eventId: "order-b",
        gross: 100,
        listingId: child.id,
      });
      await getDb().execute({
        args: [secondOrder, attendee.id, child.id, parentB.id],
        sql:
          "UPDATE listing_attendees SET ledger_event_group = ?" +
          " WHERE attendee_id = ? AND listing_id = ? AND parent_listing_id = ?",
      });
      // The first-stored row's order is refunded, so that row reads
      // refunded while the second row still owes its ticket.
      await reverseOrderFor(attendee.id, child.id);

      const moved = await moveTickets("admit", [
        { attendeeId: attendee.id, count: 1, listingId: child.id },
      ]);

      // The refunded row sorts first in storage order; the ticket must land
      // on the live row, never on the refunded one.
      expect(moved).toEqual([
        {
          attendeeId: attendee.id,
          count: 1,
          listingId: child.id,
          owedAfter: 0,
        },
      ]);
      expect(await countsFor(attendee.id, child.id)).toEqual([0, 1]);
      expect(firstOrder).not.toBe(secondOrder);
    });
  },
);
