import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  checkBatchAvailability,
  createAttendeeAtomic,
  decryptAttendees,
  deleteAttendee,
  getActiveEventStats,
  getAttendee,
  getAttendeesByTokens,
  getAttendeesRaw,
  getDateAttendeeCount,
  getNewestAttendeesRaw,
  hasAvailableSpots,
  updateCheckedIn,
} from "#lib/db/attendees.ts";
import { getDb } from "#lib/db/client.ts";
import { getAllEvents, getEventWithCount } from "#lib/db/events.ts";
import {
  finalizeSession as finalizePaymentSession,
  isSessionProcessed,
  reserveSession,
} from "#lib/db/processed-payments.ts";
import { CONFIG_KEYS, settings } from "#lib/db/settings.ts";
import {
  createPaidTestAttendee,
  createTestAttendee,
  createTestEvent,
  describeWithEnv,
  getTestPrivateKey,
} from "#test-utils";

describeWithEnv("db > attendees", { db: true }, () => {
  describe("CRUD", () => {
    test("getAttendee returns null for missing attendee", async () => {
      const privateKey = await getTestPrivateKey();
      const attendee = await getAttendee(999, privateKey);
      expect(attendee).toBeNull();
    });

    test("getAttendee returns attendee by id", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const created = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );
      const privateKey = await getTestPrivateKey();
      const fetched = await getAttendee(created.id, privateKey);

      expect(fetched).not.toBeNull();
      expect(fetched?.name).toBe("John Doe");
    });

    test("deleteAttendee removes attendee", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "John Doe",
        "john@example.com",
      );

      await deleteAttendee(attendee.id);

      const privateKey = await getTestPrivateKey();
      const fetched = await getAttendee(attendee.id, privateKey);
      expect(fetched).toBeNull();
    });

    test("deleteAttendee removes processed payment records", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Jane Doe",
        "jane@example.com",
      );

      await reserveSession("sess_attendee_delete");
      await finalizePaymentSession("sess_attendee_delete", attendee.id);

      await deleteAttendee(attendee.id);

      const processed = await isSessionProcessed("sess_attendee_delete");
      expect(processed).toBeNull();
    });
  });

  describe("decryption", () => {
    test("decryptAttendees returns empty array when no attendees", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const privateKey = await getTestPrivateKey();
      const raw = await getAttendeesRaw(event.id);
      const attendees = await decryptAttendees(raw, privateKey);
      expect(attendees).toEqual([]);
    });

    test("decryptAttendees returns decrypted attendees for event", async () => {
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

    test("decryptAttendees decrypts phone when present", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      const result = await createAttendeeAtomic({
        name: "Phone Person",
        email: "phone@example.com",
        phone: "+44 7700 900000",
        bookings: [{ eventId: event.id, quantity: 1 }],
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

    test("decryptAttendees handles empty email, phone, address, and special_instructions strings", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      const result = await createAttendeeAtomic({
        name: "NoContact Person",
        email: "",
        phone: "",
        address: "",
        special_instructions: "",
        bookings: [{ eventId: event.id, quantity: 1 }],
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
        name: "Instructions Person",
        email: "inst@example.com",
        special_instructions: "No nuts please\nAllergic to dairy",
        bookings: [{ eventId: event.id, quantity: 1 }],
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
        name: "Address Person",
        email: "addr@example.com",
        address: "123 Main St\nSpringfield\nIL 62701",
        bookings: [{ eventId: event.id, quantity: 1 }],
      });

      expect(result.success).toBe(true);
      const privateKey = await getTestPrivateKey();
      const raw = await getAttendeesRaw(event.id);
      const attendees = await decryptAttendees(raw, privateKey);
      expect(attendees.length).toBe(1);
      expect(attendees[0]?.address).toBe("123 Main St\nSpringfield\nIL 62701");
    });

    test("decryptAttendeeOrNull returns null when row is null", async () => {
      const { decryptAttendeeOrNull } = await import("#lib/db/attendees.ts");
      const privateKey = await getTestPrivateKey();
      const result = await decryptAttendeeOrNull(null, privateKey);
      expect(result).toBeNull();
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
        sql: `UPDATE attendees
              SET checked_in = ''
              WHERE id IN (
                SELECT attendee_id
                FROM event_attendees
                WHERE event_id = ?
              )`,
        args: [event.id],
      });

      const privateKey = await getTestPrivateKey();
      const rows = await getAttendeesRaw(event.id);
      expect((rows[0] as unknown as Record<string, unknown>).checked_in).toBe(
        0,
      );

      const decrypted = await decryptAttendees(rows, privateKey);
      expect(decrypted[0]?.checked_in).toBe(false);
    });
  });

  describe("stats", () => {
    test("getNewestAttendeesRaw returns attendees across events ordered by newest first", async () => {
      const event1 = await createTestEvent({ maxAttendees: 10 });
      const event2 = await createTestEvent({ maxAttendees: 10 });

      await createTestAttendee(
        event1.id,
        event1.slug,
        "First",
        "first@example.com",
      );
      await createTestAttendee(
        event2.id,
        event2.slug,
        "Second",
        "second@example.com",
      );
      await createTestAttendee(
        event1.id,
        event1.slug,
        "Third",
        "third@example.com",
      );

      const privateKey = await getTestPrivateKey();
      const raw = await getNewestAttendeesRaw(10);
      const attendees = await decryptAttendees(raw, privateKey);
      expect(attendees.length).toBe(3);
      // Newest first
      expect(attendees[0]?.name).toBe("Third");
    });

    test("getNewestAttendeesRaw respects limit", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      for (let i = 0; i < 3; i++) {
        await createTestAttendee(
          event.id,
          event.slug,
          `Name${i}`,
          `n${i}@example.com`,
        );
      }

      const raw = await getNewestAttendeesRaw(2);
      expect(raw.length).toBe(2);
    });

    test("getNewestAttendeesRaw returns empty array when no attendees", async () => {
      const raw = await getNewestAttendeesRaw(10);
      expect(raw).toEqual([]);
    });

    test("getActiveEventStats returns zeros for empty events", async () => {
      const stats = await getActiveEventStats([]);
      expect(stats).toEqual({ income: 0, tickets: 0, attendees: 0 });
    });

    test("getActiveEventStats returns zeros when all events inactive", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 500,
      });
      await createPaidTestAttendee(
        event.id,
        "Alice",
        "alice@example.com",
        "pay_1",
        1000,
      );
      const events = await getAllEvents();
      const inactive = events.map((e) => ({ ...e, active: false }));
      const stats = await getActiveEventStats(inactive);
      expect(stats).toEqual({ income: 0, tickets: 0, attendees: 0 });
    });

    test("getActiveEventStats counts tickets and sums income for active events", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 500,
      });
      await createPaidTestAttendee(
        event.id,
        "Alice",
        "alice@example.com",
        "pay_1",
        1000,
      );
      await createPaidTestAttendee(
        event.id,
        "Bob",
        "bob@example.com",
        "pay_2",
        2000,
      );
      const events = await getAllEvents();
      const stats = await getActiveEventStats(events);
      expect(stats.tickets).toBe(2);
      expect(stats.income).toBe(3000);
      expect(stats.attendees).toBe(2);
    });

    test("getActiveEventStats excludes inactive events", async () => {
      const event1 = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 500,
      });
      const event2 = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 500,
      });
      await createPaidTestAttendee(
        event1.id,
        "Alice",
        "alice@example.com",
        "pay_1",
        1000,
      );
      await createPaidTestAttendee(
        event2.id,
        "Bob",
        "bob@example.com",
        "pay_2",
        2000,
      );
      const events = await getAllEvents();
      const mixed = events.map((e) =>
        e.id === event2.id ? { ...e, active: false } : e
      );
      const stats = await getActiveEventStats(mixed);
      expect(stats.tickets).toBe(1);
      expect(stats.income).toBe(1000);
      expect(stats.attendees).toBe(1);
    });

    test("getActiveEventStats treats non-numeric price_paid as zero", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        unitPrice: 0,
      });
      await createPaidTestAttendee(
        event.id,
        "Free Alice",
        "free@example.com",
        "",
        0,
      );
      const events = await getAllEvents();
      const stats = await getActiveEventStats(events);
      expect(stats.tickets).toBe(1);
      expect(stats.income).toBe(0);
      expect(stats.attendees).toBe(1);
    });

    test("attendee count reflects in getEventWithCount", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(event.id, event.slug, "Alice", "a@example.com");
      await createTestAttendee(event.id, event.slug, "Bob", "b@example.com");

      const fetched = await getEventWithCount(event.id);
      expect(fetched?.attendee_count).toBe(2);
    });

    test("attendee count reflects in getAllEvents", async () => {
      const event1 = await createTestEvent({ maxAttendees: 50 });
      const event2 = await createTestEvent({ maxAttendees: 50 });

      await createTestAttendee(event1.id, event1.slug, "A", "a@example.com");
      await createTestAttendee(event1.id, event1.slug, "B", "b@example.com");
      await createTestAttendee(event2.id, event2.slug, "C", "c@example.com");

      const events = await getAllEvents();
      const byId = new Map(events.map((e) => [e.id, e.attendee_count]));
      expect(byId.get(event1.id)).toBe(2);
      expect(byId.get(event2.id)).toBe(1);
    });
  });

  describe("createAttendeeAtomic", () => {
    test("succeeds when capacity available", async () => {
      const event = await createTestEvent({
        maxAttendees: 5,
        thankYouUrl: "https://example.com",
      });

      const result = await createAttendeeAtomic({
        name: "John",
        email: "john@example.com",
        bookings: [{ eventId: event.id, quantity: 2 }],
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
        name: "Multi Buyer",
        email: "multi@example.com",
        bookings: [
          { eventId: event1.id, quantity: 2 },
          { eventId: event2.id, quantity: 3 },
        ],
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
        name: "First",
        email: "first@example.com",
        bookings: [{ eventId: event.id }],
      });

      const result = await createAttendeeAtomic({
        name: "Second",
        email: "second@example.com",
        bookings: [{ eventId: event.id, quantity: 1 }],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe("capacity_exceeded");
      }
    });

    test("fails with empty bookings", async () => {
      const result = await createAttendeeAtomic({
        name: "Nobody",
        email: "nobody@example.com",
        bookings: [],
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
        sql: "DELETE FROM settings WHERE key = ?",
        args: [CONFIG_KEYS.PUBLIC_KEY],
      });
      settings.invalidateCache();

      const result = await createAttendeeAtomic({
        name: "John",
        email: "john@example.com",
        bookings: [{ eventId: event.id }],
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
        name: "Paying Customer",
        email: "pay@example.com",
        paymentId: "pi_test_price",
        bookings: [{ eventId: event.id, quantity: 1, pricePaid: 2500 }],
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

  describe("hasAvailableSpots", () => {
    test("returns false for non-existent event", async () => {
      const result = await hasAvailableSpots(999);
      expect(result).toBe(false);
    });

    test("returns true when spots available", async () => {
      const event = await createTestEvent({
        maxAttendees: 2,
        thankYouUrl: "https://example.com",
      });
      const result = await hasAvailableSpots(event.id);
      expect(result).toBe(true);
    });

    test("returns true when some spots taken", async () => {
      const event = await createTestEvent({
        maxAttendees: 2,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(
        event.id,
        event.slug,
        "John",
        "john@example.com",
      );

      const result = await hasAvailableSpots(event.id);
      expect(result).toBe(true);
    });

    test("returns false when event is full", async () => {
      const event = await createTestEvent({
        maxAttendees: 2,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(
        event.id,
        event.slug,
        "John",
        "john@example.com",
      );
      await createTestAttendee(
        event.id,
        event.slug,
        "Jane",
        "jane@example.com",
      );

      const result = await hasAvailableSpots(event.id);
      expect(result).toBe(false);
    });

    test("checks per-date capacity for daily events", async () => {
      const event = await createTestEvent({
        maxAttendees: 1,
        eventType: "daily",
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });

      await createAttendeeAtomic({
        name: "Day User",
        email: "day@example.com",
        bookings: [{ eventId: event.id, date: "2026-02-10" }],
      });

      const full = await hasAvailableSpots(event.id, 1, "2026-02-10");
      expect(full).toBe(false);

      const available = await hasAvailableSpots(event.id, 1, "2026-02-11");
      expect(available).toBe(true);
    });
  });

  describe("getDateAttendeeCount", () => {
    const dailyOpts = {
      eventType: "daily" as const,
      bookableDays: [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
      ],
      minimumDaysBefore: 0,
      maximumDaysAfter: 14,
    };

    test("returns 0 when no attendees for date", async () => {
      const event = await createTestEvent({
        maxAttendees: 10,
        ...dailyOpts,
      });
      const count = await getDateAttendeeCount(event.id, "2026-02-10");
      expect(count).toBe(0);
    });

    test("returns correct count for date with attendees", async () => {
      const event = await createTestEvent({
        maxAttendees: 10,
        ...dailyOpts,
      });

      await createAttendeeAtomic({
        name: "User 1",
        email: "u1@example.com",
        bookings: [{ eventId: event.id, quantity: 2, date: "2026-02-10" }],
      });
      await createAttendeeAtomic({
        name: "User 2",
        email: "u2@example.com",
        bookings: [{ eventId: event.id, quantity: 3, date: "2026-02-10" }],
      });

      const count = await getDateAttendeeCount(event.id, "2026-02-10");
      expect(count).toBe(5);
    });

    test("does not count attendees on different dates", async () => {
      const event = await createTestEvent({
        maxAttendees: 10,
        ...dailyOpts,
      });

      await createAttendeeAtomic({
        name: "User 1",
        email: "u1@example.com",
        bookings: [{ eventId: event.id, quantity: 2, date: "2026-02-10" }],
      });
      await createAttendeeAtomic({
        name: "User 2",
        email: "u2@example.com",
        bookings: [{ eventId: event.id, quantity: 1, date: "2026-02-11" }],
      });

      expect(await getDateAttendeeCount(event.id, "2026-02-10")).toBe(2);
      expect(await getDateAttendeeCount(event.id, "2026-02-11")).toBe(1);
    });
  });

  describe("checkBatchAvailability", () => {
    test("returns true for empty items", async () => {
      expect(await checkBatchAvailability([])).toBe(true);
    });

    test("returns false when event not found", async () => {
      expect(
        await checkBatchAvailability([{ eventId: 999, quantity: 1 }]),
      ).toBe(false);
    });

    test("checks per-date capacity for daily events", async () => {
      const event = await createTestEvent({
        maxAttendees: 2,
        eventType: "daily",
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        minimumDaysBefore: 0,
        maximumDaysAfter: 14,
      });

      await createAttendeeAtomic({
        name: "Filled",
        email: "filled@example.com",
        bookings: [{ eventId: event.id, quantity: 2, date: "2026-05-01" }],
      });

      // Same date is full
      expect(
        await checkBatchAvailability(
          [{ eventId: event.id, quantity: 1 }],
          "2026-05-01",
        ),
      ).toBe(false);

      // Different date has room
      expect(
        await checkBatchAvailability(
          [{ eventId: event.id, quantity: 2 }],
          "2026-05-02",
        ),
      ).toBe(true);
    });
  });

  describe("getAttendeesByTokens", () => {
    test("returns attendees in token order", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });

      const { createTestAttendeeDirect } = await import("#test-utils");
      const { attendee: a1, token: token1 } = await createTestAttendeeDirect(
        event.id,
        "Tok1",
        "tok1@example.com",
      );
      const { attendee: a2, token: token2 } = await createTestAttendeeDirect(
        event.id,
        "Tok2",
        "tok2@example.com",
      );

      const results = await getAttendeesByTokens([token2, token1]);
      expect(results.length).toBe(2);
      expect(results[0]?.id).toBe(a2.id);
      expect(results[1]?.id).toBe(a1.id);
    });

    test("returns null for missing tokens", async () => {
      const results = await getAttendeesByTokens(["nonexistent"]);
      expect(results.length).toBe(1);
      expect(results[0]).toBeNull();
    });

    test("returns empty bookings for orphaned attendee", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const { createTestAttendeeDirect: createDirect } = await import(
        "#test-utils"
      );
      const { attendee, token } = await createDirect(
        event.id,
        "Orphan",
        "orphan@test.com",
      );
      await getDb().execute({
        sql: "DELETE FROM event_attendees WHERE attendee_id = ?",
        args: [attendee.id],
      });
      const results = await getAttendeesByTokens([token]);
      expect(results[0]).not.toBeNull();
      expect(results[0]!.bookings).toEqual([]);
    });
  });

  describe("updateEventLink", () => {
    test("updates quantity with capacity guard", async () => {
      const { updateEventLink } = await import("#lib/db/attendees.ts");
      const event = await createTestEvent({ maxAttendees: 5 });
      const result = await createAttendeeAtomic({
        name: "Link",
        email: "link@test.com",
        bookings: [{ eventId: event.id, quantity: 2 }],
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const update = await updateEventLink(result.attendees[0]!.id, event.id, {
        quantity: 3,
        date: null,
      });
      expect(update.success).toBe(true);

      const raw = await getAttendeesRaw(event.id);
      expect(raw[0]!.quantity).toBe(3);
    });

    test("rejects update that would exceed capacity", async () => {
      const { updateEventLink } = await import("#lib/db/attendees.ts");
      const event = await createTestEvent({ maxAttendees: 3 });
      const result = await createAttendeeAtomic({
        name: "Cap",
        email: "cap@test.com",
        bookings: [{ eventId: event.id, quantity: 2 }],
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const update = await updateEventLink(result.attendees[0]!.id, event.id, {
        quantity: 4,
        date: null,
      });
      expect(update.success).toBe(false);
    });

    test("updates date for daily event link", async () => {
      const { updateEventLink } = await import("#lib/db/attendees.ts");
      const event = await createTestEvent({
        maxAttendees: 10,
        eventType: "daily",
      });
      const result = await createAttendeeAtomic({
        name: "Daily",
        email: "daily@test.com",
        bookings: [{ eventId: event.id, date: "2026-04-07" }],
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const update = await updateEventLink(result.attendees[0]!.id, event.id, {
        quantity: 1,
        date: "2026-04-08",
      });
      expect(update.success).toBe(true);

      const raw = await getAttendeesRaw(event.id);
      expect(raw[0]!.date).toBe("2026-04-08");
    });
  });

  describe("updateCheckedIn", () => {
    test("updates checked_in to true for existing attendee", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Check User",
        "check@example.com",
      );

      await updateCheckedIn(attendee.id, event.id, true);

      const privateKey = await getTestPrivateKey();
      const rows = await getAttendeesRaw(event.id);
      const decrypted = await decryptAttendees(rows, privateKey);
      expect(decrypted[0]?.checked_in).toBe(true);
    });

    test("updates checked_in back to false", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Check User",
        "check@example.com",
      );

      await updateCheckedIn(attendee.id, event.id, true);
      await updateCheckedIn(attendee.id, event.id, false);

      const privateKey = await getTestPrivateKey();
      const rows = await getAttendeesRaw(event.id);
      const decrypted = await decryptAttendees(rows, privateKey);
      expect(decrypted[0]?.checked_in).toBe(false);
    });
  });
});
