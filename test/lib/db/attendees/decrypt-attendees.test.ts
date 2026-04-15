import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  createAttendeeAtomic,
  decryptAttendees,
  getAttendeesRaw,
} from "#lib/db/attendees.ts";
import { getDb } from "#lib/db/client.ts";
import {
  createTestAttendee,
  createTestEvent,
  describeWithEnv,
  getTestPrivateKey,
} from "#test-utils";

describeWithEnv("db > attendees > decryptAttendees", { db: true }, () => {
  test("returns empty array when no attendees", async () => {
    const event = await createTestEvent({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });
    const privateKey = await getTestPrivateKey();
    const raw = await getAttendeesRaw(event.id);
    const attendees = await decryptAttendees(raw, privateKey);
    expect(attendees).toEqual([]);
  });

  test("returns decrypted attendees for event", async () => {
    const event = await createTestEvent({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });
    await createTestAttendee(
      event.id,
      event.slug,
      "John Doe",
      "john@example.com",
    );
    await createTestAttendee(
      event.id,
      event.slug,
      "Jane Doe",
      "jane@example.com",
    );

    const privateKey = await getTestPrivateKey();
    const raw = await getAttendeesRaw(event.id);
    const attendees = await decryptAttendees(raw, privateKey);
    expect(attendees.length).toBe(2);
    const names = attendees.map((a) => a.name).sort();
    expect(names).toEqual(["Jane Doe", "John Doe"]);
  });

  test("decrypts phone when present", async () => {
    const event = await createTestEvent({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });

    const result = await createAttendeeAtomic({
      bookings: [{ eventId: event.id, quantity: 1 }],
      email: "phone@example.com",
      name: "Phone Person",
      phone: "+44 7700 900000",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.attendees[0]!.phone).toBe("+44 7700 900000");
    }

    const privateKey = await getTestPrivateKey();
    const raw = await getAttendeesRaw(event.id);
    const attendees = await decryptAttendees(raw, privateKey);
    expect(attendees.length).toBe(1);
    expect(attendees[0]?.phone).toBe("+44 7700 900000");
    expect(attendees[0]?.name).toBe("Phone Person");
  });

  test("handles empty email, phone, address, and special_instructions strings", async () => {
    const event = await createTestEvent({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });

    const result = await createAttendeeAtomic({
      address: "",
      bookings: [{ eventId: event.id, quantity: 1 }],
      email: "",
      name: "NoContact Person",
      phone: "",
      special_instructions: "",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.attendees[0]!.email).toBe("");
      expect(result.attendees[0]!.phone).toBe("");
      expect(result.attendees[0]!.address).toBe("");
      expect(result.attendees[0]!.special_instructions).toBe("");
    }

    const privateKey = await getTestPrivateKey();
    const raw = await getAttendeesRaw(event.id);
    const attendees = await decryptAttendees(raw, privateKey);
    expect(attendees.length).toBe(1);
    expect(attendees[0]?.email).toBe("");
    expect(attendees[0]?.phone).toBe("");
    expect(attendees[0]?.address).toBe("");
    expect(attendees[0]?.special_instructions).toBe("");
  });

  test("encrypts and decrypts non-empty special_instructions", async () => {
    const event = await createTestEvent({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });

    const result = await createAttendeeAtomic({
      bookings: [{ eventId: event.id, quantity: 1 }],
      email: "inst@example.com",
      name: "Instructions Person",
      special_instructions: "No nuts please\nAllergic to dairy",
    });

    expect(result.success).toBe(true);
    const privateKey = await getTestPrivateKey();
    const raw = await getAttendeesRaw(event.id);
    const attendees = await decryptAttendees(raw, privateKey);
    expect(attendees.length).toBe(1);
    expect(attendees[0]?.special_instructions).toBe(
      "No nuts please\nAllergic to dairy",
    );
  });

  test("encrypts and decrypts non-empty address", async () => {
    const event = await createTestEvent({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });

    const result = await createAttendeeAtomic({
      address: "123 Main St\nSpringfield\nIL 62701",
      bookings: [{ eventId: event.id, quantity: 1 }],
      email: "addr@example.com",
      name: "Address Person",
    });

    expect(result.success).toBe(true);
    const privateKey = await getTestPrivateKey();
    const raw = await getAttendeesRaw(event.id);
    const attendees = await decryptAttendees(raw, privateKey);
    expect(attendees.length).toBe(1);
    expect(attendees[0]?.address).toBe("123 Main St\nSpringfield\nIL 62701");
  });

  test("treats empty checked_in as false for pre-migration attendees", async () => {
    const event = await createTestEvent({ maxAttendees: 100 });
    await createTestAttendee(
      event.id,
      event.slug,
      "Old User",
      "old@example.com",
    );

    // Simulate pre-migration state: set checked_in to empty string directly
    await getDb().execute({
      args: [event.id],
      sql: `UPDATE attendees
            SET checked_in = ''
            WHERE id IN (
              SELECT attendee_id
              FROM event_attendees
              WHERE event_id = ?
            )`,
    });

    const privateKey = await getTestPrivateKey();
    const rows = await getAttendeesRaw(event.id);
    expect((rows[0] as unknown as Record<string, unknown>).checked_in).toBe(0);

    const decrypted = await decryptAttendees(rows, privateKey);
    expect(decrypted[0]?.checked_in).toBe(false);
  });
});

describeWithEnv("db > attendees > decryptAttendeeOrNull", { db: true }, () => {
  test("returns null when row is null", async () => {
    const { decryptAttendeeOrNull } = await import("#lib/db/attendees.ts");
    const privateKey = await getTestPrivateKey();
    const result = await decryptAttendeeOrNull(null, privateKey);
    expect(result).toBeNull();
  });
});
