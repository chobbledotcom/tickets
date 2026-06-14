import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  applyAttendeeAtomicEdit,
  createAttendeeAtomic,
  getAttendee,
  getAttendeesRaw,
  loadExistingLines,
} from "#shared/db/attendees.ts";
import {
  bookAttendee,
  createDailyTestEvent,
  createTestEvent,
  describeWithEnv,
} from "#test-utils";
import { getTestPrivateKey } from "#test-utils/crypto.ts";

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

  test("leaves the attendee untouched when one line exceeds capacity", async () => {
    // All-or-nothing: an edit that deletes one line and changes the PII must
    // leave BOTH untouched when a different line can't fit. Regression guard
    // for the previous partial-commit behaviour (PII + DELETE committed while
    // the failing line silently no-op'd).
    const event1 = await createTestEvent({ maxAttendees: 10, name: "E1" });
    const event2 = await createTestEvent({ maxAttendees: 3, name: "E2" });
    const result = await createAttendeeAtomic({
      bookings: [
        { eventId: event1.id, quantity: 1 },
        { eventId: event2.id, quantity: 2 },
      ],
      email: "before@example.com",
      name: "Before",
    });
    if (!result.success) throw new Error("setup");
    const attendee = result.attendees[0]!;
    const existing = await loadExistingLines(attendee.id);
    const event2Key = existing.find((e) => e.booking.event_id === event2.id)!.key;
    const blob = await encryptTestBlob(
      "After",
      "after@example.com",
      attendee.ticket_token,
    );

    // Omit the event1 line (a removal) and push event2 past its cap of 3.
    // The preflight rejects the whole edit before any write touches the DB.
    const update = await applyAttendeeAtomicEdit(attendee.id, blob, [{
      date: null,
      durationDays: 1,
      eventId: event2.id,
      exists: true,
      key: event2Key,
      quantity: 5,
    }]);
    expect(update.success).toBe(false);
    if (!update.success) expect(update.reason).toBe("capacity_exceeded");

    // Nothing committed: event1 line still present, event2 still qty 2, and
    // the PII (name/email) is unchanged.
    expect((await getAttendeesRaw(event1.id)).length).toBe(1);
    expect((await getAttendeesRaw(event2.id))[0]!.quantity).toBe(2);
    const reloaded = await getAttendee(attendee.id, await getTestPrivateKey());
    expect(reloaded!.name).toBe("Before");
    expect(reloaded!.email).toBe("before@example.com");
  });

  test("updates only the targeted row when the same daily event sits on two dates", async () => {
    // Regression guard for line identity: the UPDATE must pin the row by its
    // old start_at, or a quantity change to one date would match both rows.
    const event = await createDailyTestEvent({ maxAttendees: 10 });
    const result = await createAttendeeAtomic({
      bookings: [
        { date: "2026-06-15", durationDays: 1, eventId: event.id, quantity: 1 },
        { date: "2026-06-20", durationDays: 1, eventId: event.id, quantity: 1 },
      ],
      email: "",
      name: "Two",
    });
    if (!result.success) throw new Error("setup");
    const attendee = result.attendees[0]!;
    const existing = await loadExistingLines(attendee.id);
    const june15 = existing.find((e) =>
      e.booking.start_at?.startsWith("2026-06-15")
    )!;
    const june20 = existing.find((e) =>
      e.booking.start_at?.startsWith("2026-06-20")
    )!;
    const blob = await encryptTestBlob("Two", "", attendee.ticket_token);

    const update = await applyAttendeeAtomicEdit(attendee.id, blob, [
      {
        date: "2026-06-15",
        durationDays: 1,
        eventId: event.id,
        exists: true,
        key: june15.key,
        quantity: 4,
      },
      {
        date: "2026-06-20",
        durationDays: 1,
        eventId: event.id,
        exists: true,
        key: june20.key,
        quantity: 1,
      },
    ]);
    expect(update.success).toBe(true);

    const after = await loadExistingLines(attendee.id);
    expect(after.length).toBe(2);
    const r15 = after.find((e) => e.booking.start_at?.startsWith("2026-06-15"))!;
    const r20 = after.find((e) => e.booking.start_at?.startsWith("2026-06-20"))!;
    expect(r15.booking.quantity).toBe(4);
    expect(r20.booking.quantity).toBe(1);
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
