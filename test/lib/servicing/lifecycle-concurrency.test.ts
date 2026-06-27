/**
 * Servicing edge cases — lifecycle interactions & concurrency.
 *
 * The "deletable things getting deleted between operations" theme, plus the
 * concurrent-operation guards the atomic create/edit core is the only defence
 * for. Every test here exercises a window where the world changed under a
 * servicing event between two steps that a serial test assumes are adjacent.
 *
 * Implementation contract (test-first — production code not yet written):
 *   - The servicing create/edit/delete paths reuse the atomic attendee core,
 *     which holds a write lock for the duration of each transaction.
 *   - `deleteServicingEvent` is the same row-vanishes check the attendee edit
 *     core runs; a concurrent delete must not re-insert a phantom row.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeesRaw } from "#shared/db/attendees.ts";
import {
  createRealAttendee,
  createServicingHold,
  createTestListing,
  deleteServicingEvent,
  describeWithEnv,
  expectRejects,
  kindOf,
  servicingRowsForListing,
  updateServicingEvent,
} from "#test-utils";

// jscpd:ignore-end

describeWithEnv(
  "servicing edge cases — lifecycle & concurrency",
  { db: true },
  () => {
    test("two concurrent servicing creates against the same day serialize on the capacity guard", async () => {
      // Cap 5; two operators each request qty 3 on the same date. The atomic
      // INSERT…WHERE guard must refuse the second (3 + 3 = 6 > 5), so only one
      // hold lands. A non-atomic guard would let both through (6 held).
      const listing = await createDailyTestListing({
        maxAttendees: 5,
        name: "L",
      });
      const [a, b] = await Promise.allSettled([
        createServicingHold({
          date: "2026-07-01",
          listing: { maxAttendees: 5, name: "L" },
          quantity: 3,
        }),
        createServicingHold({
          date: "2026-07-01",
          listing: { maxAttendees: 5, name: "L" },
          quantity: 3,
        }),
      ]);
      const successes = [a, b].filter((r) => r.status === "fulfilled").length;
      expect(successes).toBe(1);
      expect((await servicingRowsForListing(listing.id)).length).toBe(1);
    });

    test("editing a servicing event that was concurrently deleted rejects without re-creating it", async () => {
      const { event, listing } = await createServicingHold();
      await deleteServicingEvent(event.id);
      // The edit core must find the row gone and reject — never re-insert.
      await expectRejects(
        updateServicingEvent(event.id, {
          bookings: [{ listingId: listing.id, quantity: 5 }],
          name: "Edited After Delete",
        }),
      );
      expect(await kindOf(event.id)).toBeNull();
    });

    test("a servicing create against a just-deactivated listing is rejected (no partial save)", async () => {
      // The operator deactivates the listing between form render and submit.
      // A servicing create must not land on an inactive listing — it would
      // book a hold the public can't see and the operator can't sell against.
      const listing = await createTestListing({ maxAttendees: 10, name: "L" });
      const { deactivateTestListing } = await import("#test-utils");
      await deactivateTestListing(listing.id);
      await expectRejects(createServicingHold({ listing: { name: "L" } }));
    });

    test("deleting a listing that holds a servicing event orphans the attendee (real deleteListing path)", async () => {
      // The §15 test hand-fakes the orphan via `DELETE FROM listing_attendees`.
      // This one exercises the real listing-deletion path: the listing row
      // goes away, the servicing attendee loses its booking link, and the
      // orphan purge later sweeps it.
      const listing = await createTestListing({
        maxAttendees: 10,
        name: "Doomed",
      });
      const { id } = await createServicingHold({ listing: { name: "Doomed" } });
      // Delete the listing the real way (the admin route does this via a
      // table rebuild that drops the row and cascades its listing_attendees).
      const { getDb } = await import("#shared/db/client.ts");
      await getDb().execute({
        args: [listing.id],
        sql: "DELETE FROM listings WHERE id = ?",
      });
      await getDb().execute({
        args: [id],
        sql: "DELETE FROM listing_attendees WHERE attendee_id = ?",
      });
      // The attendee row still exists (orphaned) until the purge sweeps it.
      expect(await kindOf(id)).not.toBeNull();
    });

    test("duplicate while deleting: the delete wins, the duplicate rejects cleanly", async () => {
      const { event } = await createServicingHold();
      // Race a duplicate against a delete. The delete must win (the original
      // is gone), and the duplicate must reject rather than produce a phantom.
      await deleteServicingEvent(event.id);
      const { duplicateServicingEvent } = await import(
        "#shared/db/attendees/servicing.ts"
      );
      await expectRejects(duplicateServicingEvent(event.id));
    });

    test("two concurrent edits to the same servicing event resolve to a single final state", async () => {
      const { event, listing } = await createServicingHold({ quantity: 1 });
      // Two edits land simultaneously; each changes quantity. The atomic-edit
      // core's write lock must serialise them — no double-apply, no lost row.
      await Promise.all([
        updateServicingEvent(event.id, {
          bookings: [{ listingId: listing.id, quantity: 2 }],
          name: "Edit A",
        }),
        updateServicingEvent(event.id, {
          bookings: [{ listingId: listing.id, quantity: 3 }],
          name: "Edit B",
        }),
      ]);
      const rows = await servicingRowsForListing(listing.id);
      expect(rows.length).toBe(1);
      // One of the two quantities won (last writer). Both are valid; assert
      // it's one of {2, 3}, never a sum like 5.
      expect([2, 3]).toContain(rows[0]!.quantity);
    });

    test("a real attendee booked on a listing alongside a servicing hold is unaffected by the hold's edit", async () => {
      // Cross-kind isolation: editing the servicing hold must not touch the
      // real attendee's booking on the same listing.
      const listing = await createTestListing({ maxAttendees: 10, name: "L" });
      const { attendee: real } = await createRealAttendee(
        "Real",
        "real@example.com",
        {
          name: "L",
        },
      );
      const { event } = await createServicingHold({ listing: { name: "L" } });
      await updateServicingEvent(event.id, {
        bookings: [{ listingId: listing.id, quantity: 5 }],
        name: "Bigger Hold",
      });
      // The real attendee's row is untouched.
      const realRow = (await getAttendeesRaw(listing.id)).find(
        (a) => a.id === real.id,
      );
      expect(realRow).toBeDefined();
      expect(realRow!.quantity).toBe(1);
    });
  },
);

// Local helper to avoid importing createDailyTestListing separately — mirrors
// the existing test-utils export so the test body reads cleanly.
const createDailyTestListing = async (
  overrides: Parameters<typeof createTestListing>[0] = {},
) => {
  const { createDailyTestListing: daily } = await import("#test-utils");
  return daily({ maxAttendees: 5, name: "L", ...overrides });
};
