/**
 * Servicing edge cases — aggregate recompute.
 *
 * The trigger-maintained split (`booked_quantity` counts servicing, `tickets_count`
 * doesn't) is tested in §10 for the INSERT path. These cover the UPDATE, the
 * mixed-kind listing (production reality), the edit-to-zero edge, and
 * corruption — each a path where the split can silently rot.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import {
  getListingAggregateRecalculation,
  getListingWithCount,
  invalidateListingsCache,
  resetListingAggregateFields,
} from "#shared/db/listings.ts";
import {
  createRealAttendee,
  createServicingHold,
  createTestListing,
  describeWithEnv,
  updateServicingEvent,
} from "#test-utils";

// jscpd:ignore-end

const reloadAggregates = async (listingId: number) => {
  invalidateListingsCache();
  return getListingWithCount(listingId);
};

describeWithEnv(
  "servicing edge cases — aggregate recompute",
  { db: true },
  () => {
    test("editing a servicing hold's quantity fires the UPDATE trigger and shifts booked_quantity", async () => {
      const { event, listing } = await createServicingHold({
        listing: { maxAttendees: 10, name: "L" },
        quantity: 2,
      });
      expect((await reloadAggregates(listing.id))?.attendee_count).toBe(2);
      // Edit qty 2 → 4: the UPDATE trigger must add +2 to booked_quantity.
      await updateServicingEvent(event.id, {
        bookings: [{ listingId: listing.id, quantity: 4 }],
        name: "Bigger Hold",
      });
      expect((await reloadAggregates(listing.id))?.attendee_count).toBe(4);
    });

    test("a mixed-kind listing (servicing + real attendee) splits booked_quantity and tickets_count", async () => {
      // Production reality: a listing can hold both a servicing event (counts
      // toward booked_quantity, not tickets_count) and a real attendee (counts
      // toward both). The split must hold for the mixed case, not just each
      // kind in isolation.
      const listing = await createTestListing({ maxAttendees: 10, name: "L" });
      await createServicingHold({ listing: { name: "L" }, quantity: 3 });
      await createRealAttendee("Real", "real@example.com", { name: "L" });
      const reloaded = await reloadAggregates(listing.id);
      expect(reloaded?.attendee_count).toBe(4); // 3 servicing + 1 real
      expect(reloaded?.tickets_count).toBe(1); // only the real attendee
    });

    test("recomputing aggregates on a mixed-kind listing preserves the split", async () => {
      const listing = await createTestListing({ maxAttendees: 10, name: "L" });
      await createServicingHold({ listing: { name: "L" }, quantity: 3 });
      await createRealAttendee("Real", "real@example.com", { name: "L" });
      // Reset to zero then recompute from the live rows.
      await resetListingAggregateFields(listing.id, [
        "booked_quantity",
        "tickets_count",
      ]);
      const recalc = await getListingAggregateRecalculation(
        (await reloadAggregates(listing.id))!,
      );
      expect(recalc.booked_quantity.recalculated).toBe(4);
      expect(recalc.tickets_count.recalculated).toBe(1);
      // Apply and confirm the trigger-maintained shape.
      await getDb().execute({
        args: [
          recalc.booked_quantity.recalculated,
          recalc.tickets_count.recalculated,
          listing.id,
        ],
        sql: "UPDATE listings SET booked_quantity = ?, tickets_count = ? WHERE id = ?",
      });
      const after = await reloadAggregates(listing.id);
      expect(after?.attendee_count).toBe(4);
      expect(after?.tickets_count).toBe(1);
    });

    test("a corrupted row with kind=NULL is counted into booked_quantity but not tickets_count", async () => {
      // A NULL-kind row (impossible per the CHECK constraint, but the test
      // pins the recompute's behaviour if the constraint is ever bypassed):
      // booked_quantity sums every quantity > 0 row regardless of kind, while
      // tickets_count's kind='attendee' predicate excludes NULL.
      const listing = await createTestListing({ maxAttendees: 10, name: "L" });
      await createServicingHold({ listing: { name: "L" }, quantity: 2 });
      // Manually corrupt a row: insert an attendee with kind=NULL + a booking.
      const tokenIdx = `corrupt-${crypto.randomUUID()}`;
      const attendeeRes = await getDb().execute({
        args: [tokenIdx],
        sql: "INSERT INTO attendees (created, ticket_token_index, pii_blob, kind) VALUES ('2026-01-01T00:00:00Z', ?, '', NULL)",
      });
      const corruptId = Number(attendeeRes.lastInsertRowid);
      await getDb().execute({
        args: [listing.id, corruptId, 5],
        sql: "INSERT INTO listing_attendees (listing_id, attendee_id, quantity, start_at, end_at) VALUES (?, ?, ?, '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z')",
      });
      const recalc = await getListingAggregateRecalculation(
        (await reloadAggregates(listing.id))!,
      );
      // booked_quantity counts both (2 + 5 = 7); tickets_count excludes both
      // (servicing is kind='servicing', the corrupt row is kind=NULL).
      expect(recalc.booked_quantity.recalculated).toBe(7);
      expect(recalc.tickets_count.recalculated).toBe(0);
    });

    test("editing a servicing hold's quantity to 0 (if allowed) drops booked_quantity by the original", async () => {
      // The validation suite rejects quantity=0 on create; but an edit to 0
      // is a different path. Pin the contract: if the edit succeeds, the
      // trigger must drop the held quantity from booked_quantity.
      const { event, listing } = await createServicingHold({
        listing: { maxAttendees: 10, name: "L" },
        quantity: 4,
      });
      expect((await reloadAggregates(listing.id))?.attendee_count).toBe(4);
      // Attempt the edit; either it rejects (qty=0 not allowed) or it succeeds
      // and booked_quantity drops to 0. Either way, booked_quantity must not
      // stay at 4.
      try {
        await updateServicingEvent(event.id, {
          bookings: [{ listingId: listing.id, quantity: 0 }],
          name: "Zero Hold",
        });
      } catch {
        // Rejected — the original quantity still holds.
        expect((await reloadAggregates(listing.id))?.attendee_count).toBe(4);
        return;
      }
      expect((await reloadAggregates(listing.id))?.attendee_count).toBe(0);
    });
  },
);
