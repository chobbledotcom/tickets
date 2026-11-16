/**
 * Servicing edge cases — aggregate recompute.
 *
 * The trigger-maintained split (`booked_quantity` counts servicing, `tickets_count`
 * doesn't) is tested in §10 for the INSERT path. These cover the UPDATE, the
 * mixed-kind listing (production reality), and the edit-to-zero edge — each a
 * path where the split can silently rot. (A NULL-kind "corrupted" row was
 * previously pinned here too, but the 2026-06-26_attendees_kind_not_null
 * migration made `attendees.kind` a real NOT NULL invariant, so such a row can
 * no longer be inserted and the recompute no longer needs to defend against it.)
 */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  getListingWithCount,
  invalidateListingsCache,
} from "#db/listings/records.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  expectListingAggregateSplit,
  recalculateListingAggregates,
} from "#test-utils/db-helpers/listing-aggregate-recalc.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  createRealAttendee,
  createServicingHold,
  updateServicingEvent,
} from "#test-utils/servicing.ts";

const reloadAggregates = async (listingId: number) => {
  invalidateListingsCache();
  return getListingWithCount(listingId);
};

/** Build the mixed-kind fixture: listing "L" holding a servicing hold of 3
 * plus one real attendee. Returns the listing for further assertions. */
const setupListingLWithHoldAndAttendee = async () => {
  const listing = await createTestListing({ maxAttendees: 10, name: "L" });
  await createServicingHold({ listing: { name: "L" }, quantity: 3 });
  await createRealAttendee("Real", "real@example.com", { name: "L" });
  return listing;
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
      expect((await reloadAggregates(listing.id))?.attendeeCount).toBe(2);
      // Edit qty 2 → 4: the UPDATE trigger must add +2 to booked_quantity.
      await updateServicingEvent(event.id, {
        bookings: [{ listingId: listing.id, quantity: 4 }],
        name: "Bigger Hold",
      });
      expect((await reloadAggregates(listing.id))?.attendeeCount).toBe(4);
    });

    test("a mixed-kind listing (servicing + real attendee) splits booked_quantity and tickets_count", async () => {
      // Production reality: a listing can hold both a servicing event (counts
      // toward booked_quantity, not tickets_count) and a real attendee (counts
      // toward both). The split must hold for the mixed case, not just each
      // kind in isolation.
      const listing = await setupListingLWithHoldAndAttendee();
      const reloaded = await reloadAggregates(listing.id);
      expect(reloaded).toMatchObject({
        attendeeCount: 4, // 3 servicing + 1 real
        ticketsCount: 1, // only the real attendee
      });
    });

    test("recomputing aggregates on a mixed-kind listing preserves the split", async () => {
      const listing = await setupListingLWithHoldAndAttendee();
      // 3 servicing + 1 real book 4 places, and only the real attendee is a
      // ticket, so the recompute and the triggers must keep that split.
      expectListingAggregateSplit(
        await recalculateListingAggregates(listing.id),
        { bookedQuantity: 4, ticketsCount: 1 },
      );
    });

    test("editing a servicing hold's quantity to 0 (if allowed) drops booked_quantity by the original", async () => {
      // The validation suite rejects quantity=0 on create; but an edit to 0
      // is a different path. Pin the contract: if the edit succeeds, the
      // trigger must drop the held quantity from booked_quantity.
      const { event, listing } = await createServicingHold({
        listing: { maxAttendees: 10, name: "L" },
        quantity: 4,
      });
      expect((await reloadAggregates(listing.id))?.attendeeCount).toBe(4);
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
        expect((await reloadAggregates(listing.id))?.attendeeCount).toBe(4);
        return;
      }
      expect((await reloadAggregates(listing.id))?.attendeeCount).toBe(0);
    });
  },
);
