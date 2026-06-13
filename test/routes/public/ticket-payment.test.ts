import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ensureAllBookings,
  processFreeReservation,
} from "#routes/public/ticket-payment.ts";
import { createAttendeeAtomic, getAttendeesRaw } from "#shared/db/attendees.ts";
import { getEventWithCount } from "#shared/db/events.ts";
import type { ContactInfo, EventWithCount } from "#shared/types.ts";
import { buildTicketEvent, type TicketEvent } from "#templates/public.tsx";
import { createTestEvent, createTestGroup, describeWithEnv } from "#test-utils";

const contact: ContactInfo = {
  address: "",
  email: "buyer@example.com",
  name: "Buyer",
  phone: "",
  special_instructions: "",
};

/** Fetch an event with its live attendee count and wrap it as a TicketEvent. */
const ticketEventFor = async (eventId: number): Promise<TicketEvent> => {
  const event = (await getEventWithCount(eventId)) as EventWithCount;
  return buildTicketEvent(event, false, undefined);
};

describeWithEnv("routes > public > ticket-payment", { db: true }, () => {
  describe("ensureAllBookings", () => {
    test("ok when every booking in the cart succeeded", async () => {
      const e1 = await createTestEvent({ maxAttendees: 10, name: "ok-a" });
      const e2 = await createTestEvent({ maxAttendees: 10, name: "ok-b" });
      const result = await createAttendeeAtomic({
        bookings: [
          { eventId: e1.id, quantity: 1 },
          { eventId: e2.id, quantity: 1 },
        ],
        email: contact.email,
        name: contact.name,
      });
      const check = await ensureAllBookings(result, 2);
      expect(check.ok).toBe(true);
      expect((await getAttendeesRaw(e1.id)).length).toBe(1);
      expect((await getAttendeesRaw(e2.id)).length).toBe(1);
    });

    test("rolls back a partially-fulfilled cart and reports capacity_exceeded", async () => {
      // Group cap 3 forces the second line to fail; createAttendeeAtomic books
      // the first greedily, leaving a partial attendee. ensureAllBookings must
      // delete it so the customer is never left with half a cart.
      const group = await createTestGroup({
        maxAttendees: 3,
        name: "rollback",
        slug: "rollback",
      });
      const e1 = await createTestEvent({
        groupId: group.id,
        maxAttendees: 10,
        name: "rollback-a",
      });
      const e2 = await createTestEvent({
        groupId: group.id,
        maxAttendees: 10,
        name: "rollback-b",
      });
      const result = await createAttendeeAtomic({
        bookings: [
          { eventId: e1.id, quantity: 2 },
          { eventId: e2.id, quantity: 2 },
        ],
        email: contact.email,
        name: contact.name,
      });
      // Sanity: the atomic layer fulfilled only the first line.
      expect(result.success).toBe(true);
      if (result.success) expect(result.attendees.length).toBe(1);

      const check = await ensureAllBookings(result, 2);
      expect(check.ok).toBe(false);
      if (!check.ok) expect(check.reason).toBe("capacity_exceeded");
      // Full rollback: even the first line's row is gone.
      expect((await getAttendeesRaw(e1.id)).length).toBe(0);
      expect((await getAttendeesRaw(e2.id)).length).toBe(0);
    });

    test("propagates the failure reason when the whole cart failed", async () => {
      const failure = {
        reason: "encryption_error" as const,
        success: false as const,
      };
      const check = await ensureAllBookings(failure, 1);
      expect(check).toEqual({ ok: false, reason: "encryption_error" });
    });
  });

  describe("processFreeReservation (all-or-nothing)", () => {
    test("rejects the whole cart and persists nothing when a group cap is partially exceeded", async () => {
      const group = await createTestGroup({
        maxAttendees: 3,
        name: "free-rollback",
        slug: "free-rollback",
      });
      const e1 = await createTestEvent({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 10,
        name: "free-a",
      });
      const e2 = await createTestEvent({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 10,
        name: "free-b",
      });
      const ticketEvents = [
        await ticketEventFor(e1.id),
        await ticketEventFor(e2.id),
      ];
      const quantities = new Map([
        [e1.id, 2],
        [e2.id, 2],
      ]);
      const result = await processFreeReservation(
        ticketEvents,
        quantities,
        contact,
        null,
      );
      expect(result.success).toBe(false);
      // Nothing persists for either event — the partial booking is rolled back.
      expect((await getAttendeesRaw(e1.id)).length).toBe(0);
      expect((await getAttendeesRaw(e2.id)).length).toBe(0);
    });

    test("books the whole cart when the combined order fits the group cap", async () => {
      const group = await createTestGroup({
        maxAttendees: 3,
        name: "free-ok",
        slug: "free-ok",
      });
      const e1 = await createTestEvent({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 10,
        name: "free-ok-a",
      });
      const e2 = await createTestEvent({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 10,
        name: "free-ok-b",
      });
      const ticketEvents = [
        await ticketEventFor(e1.id),
        await ticketEventFor(e2.id),
      ];
      const result = await processFreeReservation(
        ticketEvents,
        new Map([
          [e1.id, 1],
          [e2.id, 2],
        ]),
        contact,
        null,
      );
      expect(result.success).toBe(true);
      expect((await getAttendeesRaw(e1.id))[0]!.quantity).toBe(1);
      expect((await getAttendeesRaw(e2.id))[0]!.quantity).toBe(2);
    });
  });
});
