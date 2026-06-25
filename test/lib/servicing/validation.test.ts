/**
 * Servicing §14 — validation & negative paths.
 *
 * Reuses `validateAttendeeBlock` (§0) for the name-required rule and the
 * atomic-create's existing guards for the booking-shape rules: zero bookings,
 * negative quantities, and duplicate (listing, date) slots are all rejected
 * before any row is written.
 *
 * Implementation contract (test-first):
 *   - `createServicingEvent` runs the same pre-insert validation as
 *     `createAttendeeAtomic` (`NO_LINES_ERROR`, negative-quantity guard,
 *     duplicate-slot guard) plus the shared name-required check.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  createDailyTestListing,
  createTestListing,
  createTestServicingEvent,
  describeWithEnv,
  expectRejects,
} from "#test-utils";

// jscpd:ignore-end

describeWithEnv(
  "servicing §14 — validation & negative paths",
  { db: true },
  () => {
    test("a blank name is rejected with the name-required error", async () => {
      const listing = await createTestListing({ maxAttendees: 10, name: "L" });
      await expectRejects(
        createTestServicingEvent({
          bookings: [{ listingId: listing.id, quantity: 1 }],
          name: "   ",
        }),
        /name/i,
      );
    });

    test("zero bookings is rejected (NO_LINES_ERROR)", async () => {
      await expectRejects(
        createTestServicingEvent({ bookings: [], name: "Boiler Service" }),
      );
    });

    test("a negative quantity is rejected, never stored (would skew capacity sums)", async () => {
      const listing = await createTestListing({ maxAttendees: 10, name: "L" });
      await expectRejects(
        createTestServicingEvent({
          bookings: [{ listingId: listing.id, quantity: -2 }],
          name: "Boiler Service",
        }),
      );
    });

    test("duplicate (listing, date) slots in one submission are rejected (unique-index guard)", async () => {
      const listing = await createDailyTestListing({
        maxAttendees: 10,
        name: "L",
      });
      await expectRejects(
        createTestServicingEvent({
          bookings: [
            { date: "2026-07-01", listingId: listing.id, quantity: 1 },
            { date: "2026-07-01", listingId: listing.id, quantity: 1 },
          ],
          name: "Boiler Service",
        }),
      );
      // Different dates on the same listing are fine (control).
      const ok = await createTestServicingEvent({
        bookings: [
          { date: "2026-07-01", listingId: listing.id, quantity: 1 },
          { date: "2026-07-02", listingId: listing.id, quantity: 1 },
        ],
        name: "Two-Day Service",
      });
      expect(ok.id).toBeGreaterThan(0);
    });
  },
);
