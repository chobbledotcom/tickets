import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  createAttendeeAtomic,
  decryptAttendees,
  getAttendeesRaw,
} from "#lib/db/attendees.ts";
import { getDb } from "#lib/db/client.ts";
import { CONFIG_KEYS, settings } from "#lib/db/settings.ts";
import {
  createTestEvent,
  describeWithEnv,
  getTestPrivateKey,
} from "#test-utils";

describeWithEnv("db > attendees > createAttendeeAtomic", { db: true }, () => {
  test("succeeds when capacity available", async () => {
    const event = await createTestEvent({
      maxAttendees: 5,
      thankYouUrl: "https://example.com",
    });

    const result = await createAttendeeAtomic({
      bookings: [{ eventId: event.id, quantity: 2 }],
      email: "john@example.com",
      name: "John",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.attendees.length).toBe(1);
      expect(result.attendees[0]!.name).toBe("John");
    }
  });

  test("links single attendee record to multiple events for group purchase", async () => {
    const event1 = await createTestEvent({ maxAttendees: 10 });
    const event2 = await createTestEvent({ maxAttendees: 10 });

    const result = await createAttendeeAtomic({
      bookings: [
        { eventId: event1.id, quantity: 2 },
        { eventId: event2.id, quantity: 3 },
      ],
      email: "multi@example.com",
      name: "Multi Buyer",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Both booking results point to the same underlying attendee row
    expect(result.attendees.length).toBe(2);
    const attendeeId = result.attendees[0]!.id;
    expect(result.attendees[1]!.id).toBe(attendeeId);

    const event1Raw = await getAttendeesRaw(event1.id);
    expect(event1Raw.length).toBe(1);
    expect(event1Raw[0]!.id).toBe(attendeeId);
    expect(event1Raw[0]!.quantity).toBe(2);

    const event2Raw = await getAttendeesRaw(event2.id);
    expect(event2Raw.length).toBe(1);
    expect(event2Raw[0]!.id).toBe(attendeeId);
    expect(event2Raw[0]!.quantity).toBe(3);
  });

  test("fails when capacity exceeded", async () => {
    const event = await createTestEvent({
      maxAttendees: 1,
      thankYouUrl: "https://example.com",
    });
    await createAttendeeAtomic({
      bookings: [{ eventId: event.id }],
      email: "first@example.com",
      name: "First",
    });

    const result = await createAttendeeAtomic({
      bookings: [{ eventId: event.id, quantity: 1 }],
      email: "second@example.com",
      name: "Second",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("capacity_exceeded");
    }
  });

  test("fails with empty bookings", async () => {
    const result = await createAttendeeAtomic({
      bookings: [],
      email: "nobody@example.com",
      name: "Nobody",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("capacity_exceeded");
    }
  });

  test("fails when encryption key not configured", async () => {
    const event = await createTestEvent({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });

    await getDb().execute({
      args: [CONFIG_KEYS.PUBLIC_KEY],
      sql: "DELETE FROM settings WHERE key = ?",
    });
    settings.invalidateCache();

    const result = await createAttendeeAtomic({
      bookings: [{ eventId: event.id }],
      email: "john@example.com",
      name: "John",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("encryption_error");
    }
  });

  test("stores and returns price_paid when provided", async () => {
    const event = await createTestEvent({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
      unitPrice: 2500,
    });

    const result = await createAttendeeAtomic({
      bookings: [{ eventId: event.id, pricePaid: 2500, quantity: 1 }],
      email: "pay@example.com",
      name: "Paying Customer",
      paymentId: "pi_test_price",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.attendees[0]!.price_paid).toBe("2500");
    }

    const privateKey = await getTestPrivateKey();
    const raw = await getAttendeesRaw(event.id);
    const attendees = await decryptAttendees(raw, privateKey);
    expect(attendees[0]?.price_paid).toBe("2500");
  });
});
