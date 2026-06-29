/**
 * Servicing §9 — single-record route guards.
 *
 * A servicing id must not be openable or actionable through any customer
 * (attendee) route, and the servicing route must not open a customer id. Every
 * guarded loader resolves through one kind-checking read (default
 * `'attendee'`), so every route 404s identically for a servicing id — copied
 * URL / activity-log link can't drive a service event through the customer
 * editor. The merge action is also guarded at the POST (not just the
 * dropdown): a hand-crafted merge involving a servicing id is refused.
 *
 * Implementation contract (test-first):
 *   - `getAttendee` and the merge/refresh/balance/listing-scoped loaders share
 *     a single kind-guarded read (§20) defaulting to `kind='attendee'`; the
 *     servicing loaders default to `kind='servicing'`.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  adminPost,
  assertAdmin404,
  assertServicingId404sEverywhere,
  createRealAttendee,
  createServicingHold,
  createTestListing,
  createTestServicingEvent,
  describeWithEnv,
  getTestSession,
  recordServiceCost,
} from "#test-utils";

// jscpd:ignore-end

describeWithEnv(
  "servicing §9 — single-record route guards",
  { db: true },
  () => {
    test("every customer (attendee) route 404s for a servicing id", async () => {
      const { id, listing } = await createServicingHold();
      await assertServicingId404sEverywhere(id, listing.id);
    });

    test("/admin/servicing/:id 404s for a normal attendee id (servicing loads only kind='servicing')", async () => {
      const { attendee } = await createRealAttendee();
      const { cookie } = await getTestSession();
      await assertAdmin404(`/admin/servicing/${attendee.id}`, cookie);
    });

    test("control: the attendee edit page 200s for a normal attendee id", async () => {
      const { attendee } = await createRealAttendee();
      const { cookie } = await getTestSession();
      const { awaitTestRequest } = await import("#test-utils/mocks.ts");
      const response = await awaitTestRequest(
        `/admin/attendees/${attendee.id}`,
        { cookie },
      );
      expect(response.status).toBe(200);
      response.body?.cancel();
    });

    test("merge POST is rejected when either id is servicing (guarded at the action)", async () => {
      const servicing = await createServicingHold();
      const { attendee: real } = await createRealAttendee();
      const response = await adminPost(
        `/admin/attendees/${servicing.id}/merge`,
        { token: real.ticket_token },
      );
      expect(response.status).toBe(404);
      response.body?.cancel();
    });
  },
);

describeWithEnv(
  "servicing §9 — mutation routes fail closed (404) for stale ids",
  { db: true },
  () => {
    test("POST /admin/servicing/:id/delete 404s for a missing service event id", async () => {
      const response = await adminPost("/admin/servicing/999999/delete", {});
      expect(response.status).toBe(404);
      response.body?.cancel();
    });

    test("POST /admin/servicing/:id/duplicate 404s for a missing service event id", async () => {
      const response = await adminPost("/admin/servicing/999999/duplicate", {});
      expect(response.status).toBe(404);
      response.body?.cancel();
    });

    test("POST /admin/servicing/:id/cost/:costId 404s for a missing cost id", async () => {
      const { id, listing } = await createServicingHold();
      const response = await adminPost(`/admin/servicing/${id}/cost/999999`, {
        amount: "60.00",
      });
      expect(response.status).toBe(404);
      response.body?.cancel();
      // No cost leg was posted for the phantom cost id.
      const { allTransfers } = await import("#shared/accounting/queries.ts");
      expect(
        (await allTransfers()).filter((t) => t.kind === "service_cost").length,
      ).toBe(0);
      const { costOf } = await import("#shared/accounting/projection.ts");
      expect(await costOf(listing.id)).toBe(0);
    });

    test("POST /admin/servicing/:id/cost/:costId 404s for a cost belonging to another event", async () => {
      const heldListing = await createTestListing({
        maxAttendees: 10,
        name: "Held Listing",
      });
      const otherListing = await createTestListing({
        maxAttendees: 10,
        name: "Other Listing",
      });
      const held = await createTestServicingEvent({
        bookings: [{ listingId: heldListing.id, quantity: 1 }],
        name: "Held",
      });
      const other = await createTestServicingEvent({
        bookings: [{ listingId: otherListing.id, quantity: 1 }],
        name: "Other",
      });
      const costId = await recordServiceCost({
        amount: 9000,
        listingId: heldListing.id,
        memo: "Boiler part",
        occurredAt: "2026-07-01T00:00:00.000Z",
        servicingId: held.id,
      });
      // The cost belongs to `held`, but it is posted through `other`'s route —
      // the cost's listing is not held by `other`, so it 404s instead of
      // silently editing a cost from a different event.
      const response = await adminPost(
        `/admin/servicing/${other.id}/cost/${costId}`,
        { amount: "60.00" },
      );
      expect(response.status).toBe(404);
      response.body?.cancel();
      const { costOf } = await import("#shared/accounting/projection.ts");
      expect(await costOf(heldListing.id)).toBe(9000);
    });

    test("POST /admin/servicing/:id/cost/:costId 404s for a cost from a different event on the SAME listing", async () => {
      // Regression guard: two events that both hold the same listing. A cost
      // recorded against event A must not be editable through event B's route,
      // even though B also holds the listing. The old listing-membership check
      // would pass for B; the direct service_costs table lookup does not.
      const sharedListing = await createTestListing({
        maxAttendees: 20,
        name: "Shared Listing",
      });
      const eventA = await createTestServicingEvent({
        bookings: [{ listingId: sharedListing.id, quantity: 1 }],
        name: "Event A",
      });
      const eventB = await createTestServicingEvent({
        bookings: [{ listingId: sharedListing.id, quantity: 1 }],
        name: "Event B",
      });
      const costId = await recordServiceCost({
        amount: 9000,
        listingId: sharedListing.id,
        memo: "Shared listing cost",
        occurredAt: "2026-07-01T00:00:00.000Z",
        servicingId: eventA.id,
      });
      // Attempting to edit event A's cost through event B's route must 404.
      const response = await adminPost(
        `/admin/servicing/${eventB.id}/cost/${costId}`,
        { amount: "60.00" },
      );
      expect(response.status).toBe(404);
      response.body?.cancel();
      // The cost is unchanged.
      const { costOf } = await import("#shared/accounting/projection.ts");
      expect(await costOf(sharedListing.id)).toBe(9000);
    });
  },
);
