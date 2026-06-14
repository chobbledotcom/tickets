import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  applyAttendeeAtomicEdit,
  getAttendeesRaw,
  loadExistingLines,
} from "#shared/db/attendees.ts";
import {
  bookAttendee,
  createDailyTestEvent,
  createTestEvent,
  describeWithEnv,
} from "#test-utils";

/** Encrypt a minimal PII blob for the test attendee. Reuses the production
 * encryptPiiBlob path so the resulting blob decrypts correctly. */
const encryptTestBlob = async (
  name: string,
  email: string,
  ticketToken: string,
): Promise<string> => {
  const { buildPiiBlob, encryptPiiBlob } = await import(
    "#shared/db/attendees/pii.ts"
  );
  const { settings } = await import("#shared/db/settings.ts");
  const blob = buildPiiBlob({
    address: "",
    email,
    name,
    payment_id: "",
    phone: "",
    special_instructions: "",
    ticket_token: ticketToken,
  });
  const encrypted = await encryptPiiBlob(blob, settings.publicKey);
  if (!encrypted) throw new Error("Failed to encrypt test PII blob");
  return encrypted;
};

describeWithEnv("db > attendees > applyAttendeeAtomicEdit", { db: true }, () => {
  test("updates PII on a single-line attendee without touching the line", async () => {
    const event = await createTestEvent({ maxAttendees: 10 });
    const result = await bookAttendee(event, {
      email: "before@example.com",
      name: "Before",
      quantity: 2,
    });
    if (!result.success) throw new Error("setup");
    const attendee = result.attendees[0]!;
    const existing = await loadExistingLines(attendee.id);
    const blob = await encryptTestBlob("After", "after@example.com", attendee.ticket_token);

    const update = await applyAttendeeAtomicEdit(attendee.id, blob, [{
      date: null,
      durationDays: 1,
      eventId: event.id,
      exists: true,
      key: existing[0]!.key,
      quantity: 2,
    }]);
    expect(update.success).toBe(true);

    // PII changed
    const { getAttendee } = await import("#shared/db/attendees.ts");
    const { getTestPrivateKey } = await import("#test-utils/crypto.ts");
    const updated = await getAttendee(attendee.id, await getTestPrivateKey());
    expect(updated!.name).toBe("After");
    expect(updated!.email).toBe("after@example.com");
    // Line unchanged
    expect((await getAttendeesRaw(event.id))[0]!.quantity).toBe(2);
  });

  test("updates an existing line's quantity", async () => {
    const event = await createTestEvent({ maxAttendees: 10, maxQuantity: 5 });
    const result = await bookAttendee(event, {
      name: "Qty",
      quantity: 1,
    });
    if (!result.success) throw new Error("setup");
    const attendee = result.attendees[0]!;
    const existing = await loadExistingLines(attendee.id);
    const blob = await encryptTestBlob("Qty", "", attendee.ticket_token);

    const update = await applyAttendeeAtomicEdit(attendee.id, blob, [{
      date: null,
      durationDays: 1,
      eventId: event.id,
      exists: true,
      key: existing[0]!.key,
      quantity: 4,
    }]);
    expect(update.success).toBe(true);
    expect((await getAttendeesRaw(event.id))[0]!.quantity).toBe(4);
  });

  test("adds a new line alongside an existing one", async () => {
    const event1 = await createTestEvent({ maxAttendees: 10, name: "E1" });
    const event2 = await createTestEvent({ maxAttendees: 10, name: "E2" });
    const result = await bookAttendee(event1, { name: "Link", quantity: 1 });
    if (!result.success) throw new Error("setup");
    const attendee = result.attendees[0]!;
    const existing = await loadExistingLines(attendee.id);
    const blob = await encryptTestBlob("Link", "", attendee.ticket_token);

    const update = await applyAttendeeAtomicEdit(attendee.id, blob, [
      {
        date: null,
        durationDays: 1,
        eventId: event1.id,
        exists: true,
        key: existing[0]!.key,
        quantity: 1,
      },
      {
        date: null,
        durationDays: 1,
        eventId: event2.id,
        exists: false,
        key: "",
        quantity: 2,
      },
    ]);
    expect(update.success).toBe(true);
    expect((await getAttendeesRaw(event1.id)).length).toBe(1);
    expect((await getAttendeesRaw(event2.id)).length).toBe(1);
    expect((await getAttendeesRaw(event2.id))[0]!.quantity).toBe(2);
  });

  test("removes a line by omitting it from the desired set", async () => {
    const event1 = await createTestEvent({ maxAttendees: 10, name: "E1" });
    const event2 = await createTestEvent({ maxAttendees: 10, name: "E2" });
    const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
    const result = await createAttendeeAtomic({
      bookings: [{ eventId: event1.id, quantity: 1 }, {
        eventId: event2.id,
        quantity: 1,
      }],
      email: "",
      name: "Multi",
    });
    if (!result.success) throw new Error("setup");
    const attendee = result.attendees[0]!;
    const existing = await loadExistingLines(attendee.id);
    const event1Key = existing.find((e) => e.booking.event_id === event1.id)!.key;
    const blob = await encryptTestBlob("Multi", "", attendee.ticket_token);

    const update = await applyAttendeeAtomicEdit(attendee.id, blob, [{
      date: null,
      durationDays: 1,
      eventId: event1.id,
      exists: true,
      key: event1Key,
      quantity: 1,
    }]);
    expect(update.success).toBe(true);
    expect((await getAttendeesRaw(event1.id)).length).toBe(1);
    expect((await getAttendeesRaw(event2.id)).length).toBe(0);
  });

  test("rejects when desired set is empty (no_lines)", async () => {
    const event = await createTestEvent({ maxAttendees: 10 });
    const result = await bookAttendee(event, { name: "X", quantity: 1 });
    if (!result.success) throw new Error("setup");
    const attendee = result.attendees[0]!;
    const blob = await encryptTestBlob("X", "", attendee.ticket_token);
    const update = await applyAttendeeAtomicEdit(attendee.id, blob, []);
    expect(update.success).toBe(false);
    if (!update.success) {
      expect(update.reason).toBe("no_lines");
    }
  });

  test("rejects duplicate (eventId, date) pairs up front", async () => {
    const event = await createTestEvent({ maxAttendees: 10 });
    const result = await bookAttendee(event, { name: "X", quantity: 1 });
    if (!result.success) throw new Error("setup");
    const attendee = result.attendees[0]!;
    const blob = await encryptTestBlob("X", "", attendee.ticket_token);
    const update = await applyAttendeeAtomicEdit(attendee.id, blob, [
      {
        date: null,
        durationDays: 1,
        eventId: event.id,
        exists: false,
        key: "",
        quantity: 1,
      },
      {
        date: null,
        durationDays: 1,
        eventId: event.id,
        exists: false,
        key: "",
        quantity: 1,
      },
    ]);
    expect(update.success).toBe(false);
    if (!update.success) {
      expect(update.reason).toBe("capacity_exceeded");
    }
  });

  test("rejects an update that exceeds event capacity", async () => {
    const event = await createTestEvent({ maxAttendees: 3 });
    const result = await bookAttendee(event, { name: "X", quantity: 2 });
    if (!result.success) throw new Error("setup");
    const attendee = result.attendees[0]!;
    const existing = await loadExistingLines(attendee.id);
    const blob = await encryptTestBlob("X", "", attendee.ticket_token);
    const update = await applyAttendeeAtomicEdit(attendee.id, blob, [{
      date: null,
      durationDays: 1,
      eventId: event.id,
      exists: true,
      key: existing[0]!.key,
      quantity: 5,
    }]);
    expect(update.success).toBe(false);
    if (!update.success) {
      expect(update.reason).toBe("capacity_exceeded");
    }
  });

  test("updates date on a daily line", async () => {
    const event = await createDailyTestEvent({ maxAttendees: 10 });
    const result = await bookAttendee(event, { date: "2026-04-07", quantity: 1 });
    if (!result.success) throw new Error("setup");
    const attendee = result.attendees[0]!;
    const existing = await loadExistingLines(attendee.id);
    const blob = await encryptTestBlob("X", "", attendee.ticket_token);
    const update = await applyAttendeeAtomicEdit(attendee.id, blob, [{
      date: "2026-04-08",
      durationDays: 1,
      eventId: event.id,
      exists: true,
      key: existing[0]!.key,
      quantity: 1,
    }]);
    expect(update.success).toBe(true);
    expect((await getAttendeesRaw(event.id))[0]!.date).toBe("2026-04-08");
  });

  test("rejects a daily update whose range hits capacity on a middle day", async () => {
    const event = await createDailyTestEvent({
      durationDays: 3,
      maxAttendees: 1,
    });
    // Fill 2026-06-02 with another booking
    await bookAttendee(event, { date: "2026-06-02", durationDays: 1, quantity: 1 });
    const target = await bookAttendee(event, {
      date: "2026-06-10",
      durationDays: 1,
      quantity: 1,
    });
    if (!target.success) throw new Error("setup");
    const attendee = target.attendees[0]!;
    const existing = await loadExistingLines(attendee.id);
    const blob = await encryptTestBlob("X", "", attendee.ticket_token);
    const update = await applyAttendeeAtomicEdit(attendee.id, blob, [{
      date: "2026-06-01",
      durationDays: 3,
      eventId: event.id,
      exists: true,
      key: existing[0]!.key,
      quantity: 1,
    }]);
    expect(update.success).toBe(false);
  });
});
