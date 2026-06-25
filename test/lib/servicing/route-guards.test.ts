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
  describeWithEnv,
  getTestSession,
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
      const { attendee, listing } = await createRealAttendee();
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
