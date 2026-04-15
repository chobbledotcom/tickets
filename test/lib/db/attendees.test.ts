import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  checkBatchAvailability,
  createAttendeeAtomic,
  dateToRange,
  decryptAttendees,
  deleteAttendee,
  getActiveEventStats,
  getAttendee,
  getAttendeesByTokens,
  getAttendeesRaw,
  getDateAttendeeCount,
  getNewestAttendeesRaw,
  hasAvailableSpots,
  recomputeEventBookingRanges,
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

    test("decryptAttendees handles empty email, phone, address, and special_instructions strings", async () => {
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
      expect(stats).toEqual({ attendees: 0, income: 0, tickets: 0 });
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
      expect(stats).toEqual({ attendees: 0, income: 0, tickets: 0 });
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
        e.id === event2.id ? { ...e, active: false } : e,
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
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        eventType: "daily",
        maxAttendees: 1,
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
      });

      await createAttendeeAtomic({
        bookings: [{ date: "2026-02-10", eventId: event.id }],
        email: "day@example.com",
        name: "Day User",
      });

      const full = await hasAvailableSpots(event.id, 1, "2026-02-10");
      expect(full).toBe(false);

      const available = await hasAvailableSpots(event.id, 1, "2026-02-11");
      expect(available).toBe(true);
    });
  });

  describe("getDateAttendeeCount", () => {
    const dailyOpts = {
      bookableDays: [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
      ],
      eventType: "daily" as const,
      maximumDaysAfter: 14,
      minimumDaysBefore: 0,
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
        bookings: [{ date: "2026-02-10", eventId: event.id, quantity: 2 }],
        email: "u1@example.com",
        name: "User 1",
      });
      await createAttendeeAtomic({
        bookings: [{ date: "2026-02-10", eventId: event.id, quantity: 3 }],
        email: "u2@example.com",
        name: "User 2",
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
        bookings: [{ date: "2026-02-10", eventId: event.id, quantity: 2 }],
        email: "u1@example.com",
        name: "User 1",
      });
      await createAttendeeAtomic({
        bookings: [{ date: "2026-02-11", eventId: event.id, quantity: 1 }],
        email: "u2@example.com",
        name: "User 2",
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
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        eventType: "daily",
        maxAttendees: 2,
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
      });

      await createAttendeeAtomic({
        bookings: [{ date: "2026-05-01", eventId: event.id, quantity: 2 }],
        email: "filled@example.com",
        name: "Filled",
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

    test("rejects multi-day booking when any day in range is at capacity", async () => {
      const event = await createTestEvent({
        durationDays: 3,
        eventType: "daily",
        maxAttendees: 2,
        maximumDaysAfter: 30,
        minimumDaysBefore: 0,
      });

      // Fill the middle day only.
      await createAttendeeAtomic({
        bookings: [{ date: "2026-05-02", eventId: event.id, quantity: 2 }],
        email: "mid@example.com",
        name: "MidFull",
      });

      // A 3-day booking starting on 2026-05-01 overlaps the filled middle day.
      expect(
        await checkBatchAvailability(
          [{ durationDays: 3, eventId: event.id, quantity: 1 }],
          "2026-05-01",
        ),
      ).toBe(false);
    });

    test("accepts multi-day booking when all days have room", async () => {
      const event = await createTestEvent({
        durationDays: 3,
        eventType: "daily",
        maxAttendees: 5,
        maximumDaysAfter: 30,
        minimumDaysBefore: 0,
      });

      expect(
        await checkBatchAvailability(
          [{ durationDays: 3, eventId: event.id, quantity: 2 }],
          "2026-05-01",
        ),
      ).toBe(true);
    });

    test("enforces group per-day cap across Saturday/Sunday/combo scenario", async () => {
      const { createTestGroup } = await import("#test-utils");
      const group = await createTestGroup({
        maxAttendees: 100,
        name: "Weekend Pass",
      });

      const saturday = await createTestEvent({
        durationDays: 1,
        eventType: "daily",
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 30,
        minimumDaysBefore: 0,
        name: "Saturday session",
      });
      const sunday = await createTestEvent({
        durationDays: 1,
        eventType: "daily",
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 30,
        minimumDaysBefore: 0,
        name: "Sunday session",
      });
      const combo = await createTestEvent({
        durationDays: 2,
        eventType: "daily",
        groupId: group.id,
        maxAttendees: 100,
        maximumDaysAfter: 30,
        minimumDaysBefore: 0,
        name: "Weekend combo",
      });

      // Fill Saturday at the group cap via the Saturday session alone.
      await createAttendeeAtomic({
        bookings: [{ date: "2026-05-02", eventId: saturday.id, quantity: 100 }],
        email: "sat@example.com",
        name: "Saturday crowd",
      });

      // A Sunday-only booking must still succeed (different day).
      expect(
        await checkBatchAvailability(
          [{ durationDays: 1, eventId: sunday.id, quantity: 50 }],
          "2026-05-03",
        ),
      ).toBe(true);

      // The combo booking overlaps Saturday — rejected by group cap.
      expect(
        await checkBatchAvailability(
          [{ durationDays: 2, eventId: combo.id, quantity: 1 }],
          "2026-05-02",
        ),
      ).toBe(false);
    });
  });

  describe("dateToRange", () => {
    test("defaults to 1 day when duration omitted", () => {
      const r = dateToRange("2026-04-15");
      expect(r.startAt).toBe("2026-04-15T00:00:00Z");
      expect(r.endAt).toBe("2026-04-16T00:00:00.000Z");
    });

    test("produces inclusive 3-day range", () => {
      const r = dateToRange("2026-04-15", 3);
      expect(r.startAt).toBe("2026-04-15T00:00:00Z");
      expect(r.endAt).toBe("2026-04-18T00:00:00.000Z");
    });
  });

  describe("multi-day bookings", () => {
    test("createAttendeeAtomic stores end_at = start_at + duration days", async () => {
      const event = await createTestEvent({
        durationDays: 3,
        eventType: "daily",
        maxAttendees: 5,
        maximumDaysAfter: 30,
        minimumDaysBefore: 0,
      });

      const result = await createAttendeeAtomic({
        bookings: [
          {
            date: "2026-05-01",
            durationDays: 3,
            eventId: event.id,
            quantity: 1,
          },
        ],
        email: "triple@example.com",
        name: "Triple",
      });
      expect(result.success).toBe(true);

      const row = await getDb().execute({
        args: [event.id],
        sql: "SELECT start_at, end_at FROM event_attendees WHERE event_id = ?",
      });
      const startAt = String(row.rows[0]!.start_at);
      const endAt = String(row.rows[0]!.end_at);
      const diffDays =
        (new Date(endAt).getTime() - new Date(startAt).getTime()) / 86_400_000;
      expect(diffDays).toBe(3);
    });

    test("recomputeEventBookingRanges updates existing end_at", async () => {
      const event = await createTestEvent({
        durationDays: 1,
        eventType: "daily",
        maxAttendees: 5,
        maximumDaysAfter: 30,
        minimumDaysBefore: 0,
      });

      await createAttendeeAtomic({
        bookings: [{ date: "2026-05-01", eventId: event.id, quantity: 1 }],
        email: "grow@example.com",
        name: "Grow",
      });

      await recomputeEventBookingRanges(event.id, 4);

      const row = await getDb().execute({
        args: [event.id],
        sql: "SELECT start_at, end_at FROM event_attendees WHERE event_id = ?",
      });
      const startAt = String(row.rows[0]!.start_at);
      const endAt = String(row.rows[0]!.end_at);
      const diffDays =
        (new Date(endAt).getTime() - new Date(startAt).getTime()) / 86_400_000;
      expect(diffDays).toBe(4);
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
        args: [attendee.id],
        sql: "DELETE FROM event_attendees WHERE attendee_id = ?",
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
        bookings: [{ eventId: event.id, quantity: 2 }],
        email: "link@test.com",
        name: "Link",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const update = await updateEventLink(result.attendees[0]!.id, event.id, {
        date: null,
        quantity: 3,
      });
      expect(update.success).toBe(true);

      const raw = await getAttendeesRaw(event.id);
      expect(raw[0]!.quantity).toBe(3);
    });

    test("rejects update that would exceed capacity", async () => {
      const { updateEventLink } = await import("#lib/db/attendees.ts");
      const event = await createTestEvent({ maxAttendees: 3 });
      const result = await createAttendeeAtomic({
        bookings: [{ eventId: event.id, quantity: 2 }],
        email: "cap@test.com",
        name: "Cap",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const update = await updateEventLink(result.attendees[0]!.id, event.id, {
        date: null,
        quantity: 4,
      });
      expect(update.success).toBe(false);
    });

    test("updates date for daily event link", async () => {
      const { updateEventLink } = await import("#lib/db/attendees.ts");
      const event = await createTestEvent({
        eventType: "daily",
        maxAttendees: 10,
      });
      const result = await createAttendeeAtomic({
        bookings: [{ date: "2026-04-07", eventId: event.id }],
        email: "daily@test.com",
        name: "Daily",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const update = await updateEventLink(result.attendees[0]!.id, event.id, {
        date: "2026-04-08",
        quantity: 1,
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

  // ──────────────────────────────────────────────────────────────
  // Defensive tests for capacity maths / SQL bomb-proofing
  // ──────────────────────────────────────────────────────────────
  describe("capacity edge cases", () => {
    test("boundary: booking ending on day N does not overlap booking starting on day N", async () => {
      // Two 1-day bookings back-to-back: end_at of the first equals start_at
      // of the second. SQL uses strict `<` / `>`, so they must not overlap.
      const event = await createTestEvent({
        durationDays: 1,
        eventType: "daily",
        maxAttendees: 1,
        maximumDaysAfter: 30,
        minimumDaysBefore: 0,
      });

      const first = await createAttendeeAtomic({
        bookings: [{ date: "2026-05-01", eventId: event.id, quantity: 1 }],
        email: "a@example.com",
        name: "A",
      });
      expect(first.success).toBe(true);

      // Same capacity (=1) but next day — must succeed.
      const second = await createAttendeeAtomic({
        bookings: [{ date: "2026-05-02", eventId: event.id, quantity: 1 }],
        email: "b@example.com",
        name: "B",
      });
      expect(second.success).toBe(true);
    });

    test("same event listed twice in one cart sums per-day demand", async () => {
      const event = await createTestEvent({
        durationDays: 1,
        eventType: "daily",
        maxAttendees: 3,
        maximumDaysAfter: 30,
        minimumDaysBefore: 0,
      });

      // Two items for same event/date adding up to 4 → exceeds cap of 3.
      const ok = await checkBatchAvailability(
        [
          { eventId: event.id, quantity: 2 },
          { eventId: event.id, quantity: 2 },
        ],
        "2026-05-01",
      );
      expect(ok).toBe(false);

      // Same events/date summing to exactly the cap → accepted.
      const okExact = await checkBatchAvailability(
        [
          { eventId: event.id, quantity: 1 },
          { eventId: event.id, quantity: 2 },
        ],
        "2026-05-01",
      );
      expect(okExact).toBe(true);
    });

    test("checkBatchAvailability admits range when adjacent 1-day bookings occupy the full cap on non-overlapping days", async () => {
      // Without per-day expansion this case would false-reject because
      // overlap-sum would see both existing bookings inside the new range.
      const event = await createTestEvent({
        durationDays: 3,
        eventType: "daily",
        maxAttendees: 2,
        maximumDaysAfter: 30,
        minimumDaysBefore: 0,
      });

      // Fill day 1 with qty=2 (separate 1-day booking) and day 3 with qty=2.
      await createAttendeeAtomic({
        bookings: [
          {
            date: "2026-05-01",
            durationDays: 1,
            eventId: event.id,
            quantity: 2,
          },
        ],
        email: "d1@example.com",
        name: "Day1",
      });
      await createAttendeeAtomic({
        bookings: [
          {
            date: "2026-05-03",
            durationDays: 1,
            eventId: event.id,
            quantity: 2,
          },
        ],
        email: "d3@example.com",
        name: "Day3",
      });

      // New 3-day booking starting 2026-05-01 covers days 1,2,3 — every day
      // is at/over capacity. Should be rejected (overlap-sum would also
      // reject, but per-day is the real check).
      expect(
        await checkBatchAvailability(
          [{ durationDays: 3, eventId: event.id, quantity: 1 }],
          "2026-05-01",
        ),
      ).toBe(false);

      // New 1-day booking on day 2 has room — must succeed.
      expect(
        await checkBatchAvailability(
          [{ durationDays: 1, eventId: event.id, quantity: 2 }],
          "2026-05-02",
        ),
      ).toBe(true);
    });

    test("updateEventLink overlap-sum behaviour on multi-day event", async () => {
      // Documents a known over-rejection in the SQL overlap-sum path used
      // by admin updates. If a 2-day event has max=2 and two non-overlapping
      // 1-day bookings of qty=1 exist, updating one of them to a new 1-day
      // slot triggers overlap-sum=2 inside the old range; since the
      // update excludes the row being edited, it still succeeds. This test
      // nails down the "excludes self" guarantee.
      const { updateEventLink } = await import("#lib/db/attendees.ts");
      const event = await createTestEvent({
        durationDays: 1,
        eventType: "daily",
        maxAttendees: 2,
        maximumDaysAfter: 30,
        minimumDaysBefore: 0,
      });

      const a = await createAttendeeAtomic({
        bookings: [{ date: "2026-05-01", eventId: event.id, quantity: 2 }],
        email: "a@example.com",
        name: "A",
      });
      expect(a.success).toBe(true);
      if (!a.success) return;

      // Moving own booking to a different day should NOT self-collide,
      // even though overlap-sum at the target date initially sees our own row.
      const move = await updateEventLink(a.attendees[0]!.id, event.id, {
        date: "2026-05-02",
        durationDays: 1,
        quantity: 2,
      });
      expect(move.success).toBe(true);

      // Stored date should be the new one.
      const rows = await getAttendeesRaw(event.id);
      expect(rows[0]!.date).toBe("2026-05-02");
    });

    test("recomputeEventBookingRanges with durationDays=0 clamps to 1", async () => {
      const event = await createTestEvent({
        durationDays: 2,
        eventType: "daily",
        maxAttendees: 5,
        maximumDaysAfter: 30,
        minimumDaysBefore: 0,
      });
      await createAttendeeAtomic({
        bookings: [
          {
            date: "2026-05-01",
            durationDays: 2,
            eventId: event.id,
            quantity: 1,
          },
        ],
        email: "c@example.com",
        name: "Clamp",
      });

      await recomputeEventBookingRanges(event.id, 0);

      const row = await getDb().execute({
        args: [event.id],
        sql: "SELECT start_at, end_at FROM event_attendees WHERE event_id = ?",
      });
      const diffDays =
        (new Date(String(row.rows[0]!.end_at)).getTime() -
          new Date(String(row.rows[0]!.start_at)).getTime()) /
        86_400_000;
      expect(diffDays).toBe(1);
    });

    test("recomputeEventBookingRanges leaves non-daily (NULL start_at) rows alone", async () => {
      const dailyEvent = await createTestEvent({
        durationDays: 1,
        eventType: "daily",
        maxAttendees: 5,
        maximumDaysAfter: 30,
        minimumDaysBefore: 0,
      });
      const standardEvent = await createTestEvent({
        eventType: "standard",
        maxAttendees: 5,
      });

      await createAttendeeAtomic({
        bookings: [
          { eventId: standardEvent.id, quantity: 1 },
          { date: "2026-05-01", eventId: dailyEvent.id, quantity: 1 },
        ],
        email: "mix@example.com",
        name: "Mixed",
      });

      await recomputeEventBookingRanges(standardEvent.id, 7);

      const row = await getDb().execute({
        args: [standardEvent.id],
        sql: "SELECT start_at, end_at FROM event_attendees WHERE event_id = ?",
      });
      expect(row.rows[0]!.start_at).toBeNull();
      expect(row.rows[0]!.end_at).toBeNull();
    });

    test("checkBatchAvailability rejects when any event in the batch does not exist", async () => {
      const event = await createTestEvent({ maxAttendees: 5 });
      expect(
        await checkBatchAvailability([
          { eventId: event.id, quantity: 1 },
          { eventId: 99999, quantity: 1 },
        ]),
      ).toBe(false);
    });

    test("atomic insert safety net: concurrent booking races are rejected", async () => {
      // Race two full-capacity bookings at the same second. Only one must win.
      const event = await createTestEvent({
        durationDays: 1,
        eventType: "daily",
        maxAttendees: 2,
        maximumDaysAfter: 30,
        minimumDaysBefore: 0,
      });

      const [first, second] = await Promise.all([
        createAttendeeAtomic({
          bookings: [{ date: "2026-05-01", eventId: event.id, quantity: 2 }],
          email: "race1@example.com",
          name: "Race1",
        }),
        createAttendeeAtomic({
          bookings: [{ date: "2026-05-01", eventId: event.id, quantity: 2 }],
          email: "race2@example.com",
          name: "Race2",
        }),
      ]);

      const wins = [first.success, second.success].filter(Boolean).length;
      expect(wins).toBe(1);

      // Stored total must be exactly the cap.
      const { count } = (await getDb()
        .execute({
          args: [event.id],
          sql: "SELECT COALESCE(SUM(quantity), 0) as count FROM event_attendees WHERE event_id = ?",
        })
        .then((r) => r.rows[0])) as { count: number };
      expect(Number(count)).toBe(2);
    });

    test("atomic insert SQL overlap-sum never admits an invalid booking", async () => {
      // The customer atomic-insert path relies on overlap-sum SQL as a
      // safety net after `checkBatchAvailability`. We bypass the preflight
      // to stress the SQL guard: it must not accept a booking that would
      // put any day over capacity.
      const event = await createTestEvent({
        durationDays: 3,
        eventType: "daily",
        maxAttendees: 2,
        maximumDaysAfter: 30,
        minimumDaysBefore: 0,
      });

      // Fill day 2 via a 1-day booking (qty=2).
      await createAttendeeAtomic({
        bookings: [
          {
            date: "2026-05-02",
            durationDays: 1,
            eventId: event.id,
            quantity: 2,
          },
        ],
        email: "mid@example.com",
        name: "Mid",
      });

      // New 3-day booking covers days 1,2,3 — day 2 is at capacity, so must
      // be rejected even with no preflight.
      const result = await createAttendeeAtomic({
        bookings: [
          {
            date: "2026-05-01",
            durationDays: 3,
            eventId: event.id,
            quantity: 1,
          },
        ],
        email: "span@example.com",
        name: "Span",
      });
      expect(result.success).toBe(false);
    });

    test("group per-day cap across two daily events sharing a day", async () => {
      const { createTestGroup } = await import("#test-utils");
      const group = await createTestGroup({ maxAttendees: 2 });
      const a = await createTestEvent({
        durationDays: 1,
        eventType: "daily",
        groupId: group.id,
        maxAttendees: 5,
        maximumDaysAfter: 30,
        minimumDaysBefore: 0,
      });
      const b = await createTestEvent({
        durationDays: 1,
        eventType: "daily",
        groupId: group.id,
        maxAttendees: 5,
        maximumDaysAfter: 30,
        minimumDaysBefore: 0,
      });

      // Fill group cap on 2026-05-01 via event A.
      await createAttendeeAtomic({
        bookings: [{ date: "2026-05-01", eventId: a.id, quantity: 2 }],
        email: "a@example.com",
        name: "A",
      });

      // Adding any quantity on event B for the same day must be rejected
      // because the shared group cap is already exhausted.
      expect(
        await checkBatchAvailability(
          [{ eventId: b.id, quantity: 1 }],
          "2026-05-01",
        ),
      ).toBe(false);

      // A different day has full group room.
      expect(
        await checkBatchAvailability(
          [{ eventId: b.id, quantity: 2 }],
          "2026-05-02",
        ),
      ).toBe(true);
    });
  });
});
