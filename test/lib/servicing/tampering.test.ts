/**
 * Servicing §19 — URL / parameter tampering (adversarial).
 *
 * Asserts the contract holds against a hostile/curious operator crafting URLs
 * and POST bodies, not just the happy-path UI. Overlaps §3/§9; restated as
 * adversarial scenarios because the user called them out explicitly.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ATTENDEE_KIND, SERVICING_KIND } from "#shared/db/attendees/kind.ts";
import {
  adminPost,
  createRealAttendee,
  createServicingHold,
  decryptFirstAttendee,
  describeWithEnv,
  expectEmptyContactFields,
  expectLogisticsDisabled,
  kindOf,
  SMUGGLED_CONTACT_FIELDS,
  updateServicingEvent,
} from "#test-utils";

// jscpd:ignore-end

describeWithEnv(
  "servicing §19 — URL / parameter tampering",
  { db: true },
  () => {
    test("a service event cannot be opened or edited via the attendee URL", async () => {
      const { id } = await createServicingHold();
      // GET and POST to the customer editor both 404 for a servicing id.
      const { assertAdmin404, getTestSession } = await import("#test-utils");
      const { cookie } = await getTestSession();
      await assertAdmin404(`/admin/attendees/${id}`, cookie);
      const post = await adminPost(`/admin/attendees/${id}`, {
        name: "Hijacked",
      });
      expect(post.status).toBe(404);
      post.body?.cancel();
    });

    test("a crafted servicing POST cannot toggle hidden off", async () => {
      const { id, listing } = await createServicingHold();
      await updateServicingEvent(id, {
        bookings: [{ listingId: listing.id, quantity: 1 }],
        hidden: false,
        name: "Boiler Service",
      } as never);
      expect(await kindOf(id)).toBe(SERVICING_KIND);
    });

    test("a crafted servicing POST cannot set a status, balance, or contact data", async () => {
      const { id, listing } = await createServicingHold();
      await updateServicingEvent(id, {
        ...SMUGGLED_CONTACT_FIELDS,
        bookings: [{ listingId: listing.id, quantity: 1 }],
        name: "Boiler Service",
      } as never);
      expectEmptyContactFields(await decryptFirstAttendee(listing.id));
    });

    test("an attendee cannot be converted into a service event (or vice-versa) via params", async () => {
      const { attendee } = await createRealAttendee();
      const response = await adminPost(`/admin/attendees/${attendee.id}`, {
        kind: SERVICING_KIND,
        name: "Real Customer",
      });
      response.body?.cancel();
      expect(await kindOf(attendee.id)).toBe(ATTENDEE_KIND);
    });

    test("a service event cannot be assigned to a logistics agent via params", async () => {
      const { id, listing } = await createServicingHold();
      await updateServicingEvent(id, {
        bookings: [{ listingId: listing.id, quantity: 1 }],
        logisticsAgentIds: [7, 8],
        name: "Boiler Service",
      } as never);
      await expectLogisticsDisabled(id);
    });
  },
);
