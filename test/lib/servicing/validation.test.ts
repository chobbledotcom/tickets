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
  adminPost,
  assertRedirectTo,
  createDailyTestListing,
  createServicingHold,
  createTestListing,
  createTestServicingEvent,
  describeWithEnv,
  expectRejects,
  getServicingEvent,
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

    test("a daily listing booking without a start date is rejected at the route (date validation)", async () => {
      // normalizeServicingForSave must throw when a daily listing is booked but
      // no start_date is provided — the route catches it and redirects back.
      const listing = await createDailyTestListing({
        maxAttendees: 5,
        name: "L",
      });
      const response = await adminPost("/admin/servicing/new", {
        [`quantity_${listing.id}`]: "1",
        name: "Bad Service",
        // Deliberately omitting start_date.
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(
        "/admin/servicing/new",
      );
      response.body?.cancel();
    });

    test("zero-quantity bookings are filtered so only positive-quantity bookings are saved", async () => {
      // normalizeServicingForSave must strip zero-quantity bookings so they
      // don't cause a NO_LINES_ERROR or attempt to insert a 0-qty row.
      const listingA = await createTestListing({ maxAttendees: 10, name: "A" });
      const listingB = await createTestListing({ maxAttendees: 10, name: "B" });
      const response = await adminPost("/admin/servicing/new", {
        [`quantity_${listingA.id}`]: "0",
        [`quantity_${listingB.id}`]: "2",
        name: "Filtered Service",
      });
      // Event was created (redirects to the new event page).
      expect(response.status).toBe(302);
      const location = response.headers.get("location") ?? "";
      response.body?.cancel();
      const eventId = Number(location.match(/\/admin\/servicing\/(\d+)/)?.[1]);
      expect(eventId).toBeGreaterThan(0);
      const event = await getServicingEvent(eventId);
      // Only the positive-quantity booking on listingB was saved.
      const bookings = event?.bookings ?? [];
      expect(bookings).toHaveLength(1);
      expect(bookings[0]?.listingId).toBe(listingB.id);
      expect(bookings[0]?.quantity).toBe(2);
    });

    test("updating a servicing event with a daily listing but no start_date redirects back with an error (update catch block)", async () => {
      // Exercises the try/catch in handleServicingPost: normalizeServicingForSave
      // throws when a daily listing is booked but start_date is absent.
      const listing = await createDailyTestListing({
        maxAttendees: 5,
        name: "L",
      });
      const { id } = await createTestServicingEvent({
        bookings: [{ date: "2026-07-01", listingId: listing.id, quantity: 1 }],
        name: "Dated Service",
      });
      const response = await adminPost(`/admin/servicing/${id}`, {
        [`quantity_${listing.id}`]: "1",
        name: "Updated",
        // Deliberately omitting start_date.
      });
      assertRedirectTo(response, `/admin/servicing/${id}`);
    });

    test("duplicating a full-capacity event redirects back with an error (duplicate catch block)", async () => {
      // Exercises the try/catch in handleServicingDuplicatePost: duplicateServicingEvent
      // calls createServicingEvent which throws when the listing is at capacity.
      const { id } = await createServicingHold({
        listing: { maxAttendees: 1, name: "Tiny" },
        quantity: 1,
      });
      // The listing now has 1/1 capacity used. Duplicating would need another slot.
      const response = await adminPost(`/admin/servicing/${id}/duplicate`, {});
      assertRedirectTo(response, `/admin/servicing/${id}`);
    });

    test("expectRejects meta: fails the enclosing test when the promise resolves", async () => {
      // This meta-test covers the 'promise resolved' path in expectRejects that
      // normal rejection tests can never reach (promise always rejects there).
      let threw = false;
      try {
        await expectRejects(Promise.resolve());
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
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
