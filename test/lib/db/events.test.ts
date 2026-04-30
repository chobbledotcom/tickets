import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import {
  getAllActivityLog,
  getEventActivityLog,
  logActivity,
} from "#shared/db/activityLog.ts";
import {
  createAttendeeAtomic,
  decryptAttendees,
  getAttendeesRaw,
} from "#shared/db/attendees.ts";
import { getDb } from "#shared/db/client.ts";
import {
  computeSlugIndex,
  deleteEvent,
  eventsTable,
  getAllEvents,
  getEvent,
  getEventsBySlugsBatch,
  getEventWithAttendeeRaw,
  getEventWithAttendeesRaw,
  getEventWithCount,
  isSlugTaken,
  writeClosesAt,
  writeEventDate,
} from "#shared/db/events.ts";
import {
  finalizeSession as finalizePaymentSession,
  isSessionProcessed,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import {
  bookAttendee,
  createTestAttendee,
  createTestEvent,
  describeWithEnv,
  getTestPrivateKey,
} from "#test-utils";

describeWithEnv("db > events", { db: true }, () => {
  describe("CRUD", () => {
    test("createEvent creates event with correct properties", async () => {
      const event = await createTestEvent({
        maxAttendees: 100,
        name: "My Test Event",
        thankYouUrl: "https://example.com/thanks",
      });

      expect(event.id).toBe(1);
      expect(event.name).toBe("My Test Event");
      expect(event.slug).toBeDefined();
      expect(event.max_attendees).toBe(100);
      expect(event.thank_you_url).toBe("https://example.com/thanks");
      expect(event.created).toBeDefined();
      expect(event.unit_price).toBe(0);
    });

    test("createEvent creates event with unit_price", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      expect(event.unit_price).toBe(1000);
    });

    test("createEvent stores and retrieves description", async () => {
      const event = await createTestEvent({
        description: "A test description",
        maxAttendees: 50,
      });

      expect(event.description).toBe("A test description");
    });

    test("createEvent defaults description to empty string", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
      });

      expect(event.description).toBe("");
    });

    test("getAllEvents returns empty array when no events", async () => {
      const events = await getAllEvents();
      expect(events).toEqual([]);
    });

    test("getAllEvents returns events with attendee count", async () => {
      await createTestEvent({
        maxAttendees: 50,
        name: "Event One",
        thankYouUrl: "https://example.com",
      });
      await createTestEvent({
        maxAttendees: 100,
        name: "Event Two",
        thankYouUrl: "https://example.com",
      });

      const events = await getAllEvents();
      expect(events.length).toBe(2);
      expect(events[0]?.attendee_count).toBe(0);
      expect(events[1]?.attendee_count).toBe(0);
    });

    test("getEvent returns null for missing event", async () => {
      const event = await getEvent(999);
      expect(event).toBeNull();
    });

    test("getEvent returns event by id", async () => {
      const created = await createTestEvent({
        maxAttendees: 50,
        name: "Fetch Test",
        thankYouUrl: "https://example.com",
      });
      const fetched = await getEvent(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched?.name).toBe("Fetch Test");
    });

    test("getEventWithCount returns null for missing event", async () => {
      const event = await getEventWithCount(999);
      expect(event).toBeNull();
    });

    test("getEventWithCount returns event with count", async () => {
      const created = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const fetched = await getEventWithCount(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched?.attendee_count).toBe(0);
    });

    test("getEventWithCount reflects added attendees", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(event.id, event.slug, "Alice", "a@example.com");
      await createTestAttendee(event.id, event.slug, "Bob", "b@example.com");

      const fetched = await getEventWithCount(event.id);
      expect(fetched?.attendee_count).toBe(2);
    });

    test("getAllEvents reflects added attendees per event", async () => {
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

    test("eventsTable.update updates event properties", async () => {
      const created = await createTestEvent({
        maxAttendees: 50,
        name: "Original Event",
        thankYouUrl: "https://example.com/original",
      });

      const updated = await eventsTable.update(created.id, {
        maxAttendees: 100,
        name: "Updated Event",
        slug: created.slug,
        slugIndex: created.slug_index,
        thankYouUrl: "https://example.com/updated",
        unitPrice: 1500,
      });

      expect(updated).not.toBeNull();
      expect(updated?.name).toBe("Updated Event");
      expect(updated?.max_attendees).toBe(100);
      expect(updated?.thank_you_url).toBe("https://example.com/updated");
      expect(updated?.unit_price).toBe(1500);
    });

    test("eventsTable.update returns null for non-existent event", async () => {
      const result = await eventsTable.update(999, {
        maxAttendees: 50,
        name: "Non Existent",
        slug: "non-existent",
        slugIndex: "non-existent",
        thankYouUrl: "https://example.com",
      });
      expect(result).toBeNull();
    });

    test("eventsTable.update can set unit_price to zero", async () => {
      const created = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      const updated = await eventsTable.update(created.id, {
        maxAttendees: 50,
        name: created.name,
        slug: created.slug,
        slugIndex: created.slug_index,
        thankYouUrl: "https://example.com",
        unitPrice: 0,
      });

      expect(updated?.unit_price).toBe(0);
    });
  });

  describe("deleteEvent", () => {
    test("removes event", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      await deleteEvent(event.id);

      const fetched = await getEvent(event.id);
      expect(fetched).toBeNull();
    });

    test("removes all attendees for the event", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
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

      await deleteEvent(event.id);

      const privateKey = await getTestPrivateKey();
      const raw = await getAttendeesRaw(event.id);
      const attendees = await decryptAttendees(raw, privateKey);
      expect(attendees).toEqual([]);
    });

    test("removes processed payment records for attendees", async () => {
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

      await reserveSession("sess_event_delete");
      await finalizePaymentSession("sess_event_delete", attendee.id);

      await deleteEvent(event.id);

      const processed = await isSessionProcessed("sess_event_delete");
      expect(processed).toBeNull();
    });

    test("removes activity log entries for the event", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      await logActivity("Action for event", event.id);
      await logActivity("Another action", event.id);
      await logActivity("Global action");

      await deleteEvent(event.id);

      const eventLog = await getEventActivityLog(event.id);
      expect(eventLog).toEqual([]);

      const allLog = await getAllActivityLog();
      const messages = allLog.map((e) => e.message);
      expect(messages).not.toContain("Action for event");
      expect(messages).not.toContain("Another action");
      expect(messages).toContain("Global action");
    });

    test("works with no attendees", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      await deleteEvent(event.id);

      const fetched = await getEvent(event.id);
      expect(fetched).toBeNull();
    });

    test("preserves attendees linked to other events", async () => {
      const event1 = await createTestEvent({ maxAttendees: 50 });
      const event2 = await createTestEvent({ maxAttendees: 50 });
      const result = await createAttendeeAtomic({
        bookings: [{ eventId: event1.id }, { eventId: event2.id }],
        email: "multi@example.com",
        name: "Multi",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      const attendeeId = result.attendees[0]!.id;

      await deleteEvent(event1.id);

      const raw = await getAttendeesRaw(event2.id);
      expect(raw.length).toBe(1);
      expect(raw[0]!.id).toBe(attendeeId);
    });

    test("cleans up orphaned attendees", async () => {
      const event = await createTestEvent({ maxAttendees: 50 });
      await createTestAttendee(
        event.id,
        event.slug,
        "Solo",
        "solo@example.com",
      );

      await deleteEvent(event.id);

      const { getDb } = await import("#shared/db/client.ts");
      const rows = await getDb().execute(
        "SELECT COUNT(*) as count FROM attendees",
      );
      expect(rows.rows[0]!.count).toBe(0);
    });

    test("invalidates cache", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      const before = await getEvent(event.id);
      expect(before).not.toBeNull();

      await eventsTable.deleteById(event.id);

      const after = await getEvent(event.id);
      expect(after).toBeNull();
    });
  });

  describe("unlinkAttendeeFromEvent", () => {
    test("removes link and preserves attendee", async () => {
      const { unlinkAttendeeFromEvent } = await import(
        "#shared/db/attendees.ts"
      );
      const event1 = await createTestEvent({ maxAttendees: 50 });
      const event2 = await createTestEvent({ maxAttendees: 50 });
      const result = await createAttendeeAtomic({
        bookings: [{ eventId: event1.id }, { eventId: event2.id }],
        email: "unlink@example.com",
        name: "Unlink",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const { attendeeDeleted } = await unlinkAttendeeFromEvent(
        result.attendees[0]!.id,
        event1.id,
      );

      expect(attendeeDeleted).toBe(false);
      const raw = await getAttendeesRaw(event2.id);
      expect(raw.length).toBe(1);
      const raw1 = await getAttendeesRaw(event1.id);
      expect(raw1.length).toBe(0);
    });

    test("deletes orphaned attendee", async () => {
      const { unlinkAttendeeFromEvent } = await import(
        "#shared/db/attendees.ts"
      );
      const event = await createTestEvent({ maxAttendees: 50 });
      const result = await bookAttendee(event, {
        email: "orphan@example.com",
        name: "Orphan",
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const { attendeeDeleted } = await unlinkAttendeeFromEvent(
        result.attendees[0]!.id,
        event.id,
      );

      expect(attendeeDeleted).toBe(true);
      const { getDb } = await import("#shared/db/client.ts");
      const rows = await getDb().execute(
        "SELECT COUNT(*) as count FROM attendees",
      );
      expect(rows.rows[0]!.count).toBe(0);
    });
  });

  describe("slug", () => {
    test("isSlugTaken with excludeEventId excludes that event", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        name: "Slug Taken Test",
        thankYouUrl: "https://example.com",
      });

      const taken = await isSlugTaken(event.slug);
      expect(taken).toBe(true);

      const notTaken = await isSlugTaken(event.slug, event.id);
      expect(notTaken).toBe(false);
    });
  });

  describe("batch queries", () => {
    test("getEventWithAttendeesRaw returns event with attendees", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(
        event.id,
        event.slug,
        "Alice",
        "alice@example.com",
      );

      const result = await getEventWithAttendeesRaw(event.id);
      expect(result).not.toBeNull();
      expect(result?.event.id).toBe(event.id);
      expect(result?.event.attendee_count).toBe(1);
      expect(result?.attendeesRaw.length).toBe(1);
    });

    test("getEventWithAttendeesRaw returns null for non-existent event", async () => {
      const result = await getEventWithAttendeesRaw(999);
      expect(result).toBeNull();
    });

    test("getEventWithAttendeeRaw returns event with count fallback", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Bob",
        "bob@example.com",
      );

      const result = await getEventWithAttendeeRaw(event.id, attendee.id);
      expect(result).not.toBeNull();
      expect(result?.event.id).toBe(event.id);
      expect(result?.attendeeRaw).not.toBeNull();
      expect(result?.event.attendee_count).toBe(1);
    });

    test("getEventWithAttendeeRaw returns null for non-existent event", async () => {
      const result = await getEventWithAttendeeRaw(999, 1);
      expect(result).toBeNull();
    });

    test("getEventsBySlugsBatch returns empty array for empty slugs", async () => {
      const result = await getEventsBySlugsBatch([]);
      expect(result).toEqual([]);
    });

    test("getEventsBySlugsBatch returns events in slug order", async () => {
      const event1 = await createTestEvent({
        maxAttendees: 10,
        name: "Batch A",
        thankYouUrl: "https://example.com",
      });
      const event2 = await createTestEvent({
        maxAttendees: 20,
        name: "Batch B",
        thankYouUrl: "https://example.com",
      });

      const results = await getEventsBySlugsBatch([event2.slug, event1.slug]);
      expect(results.length).toBe(2);
      expect(results[0]?.id).toBe(event2.id);
      expect(results[1]?.id).toBe(event1.id);
    });

    test("getEventsBySlugsBatch returns null for missing slugs", async () => {
      const event = await createTestEvent({
        maxAttendees: 10,
        name: "Exists",
        thankYouUrl: "https://example.com",
      });

      const results = await getEventsBySlugsBatch([event.slug, "missing"]);
      expect(results.length).toBe(2);
      expect(results[0]).not.toBeNull();
      expect(results[1]).toBeNull();
    });
  });

  describe("writeClosesAt", () => {
    test("encrypts empty string for no deadline", async () => {
      const { decrypt } = await import("#shared/crypto/encryption.ts");
      const result = await writeClosesAt("");
      expect(typeof result).toBe("string");
      expect(result).not.toBe("");
      const decrypted = await decrypt(result as unknown as string);
      expect(decrypted).toBe("");
    });

    test("encrypts null as empty string", async () => {
      const { decrypt } = await import("#shared/crypto/encryption.ts");
      const result = await writeClosesAt(null);
      const decrypted = await decrypt(result as unknown as string);
      expect(decrypted).toBe("");
    });

    test("normalizes datetime-local string without timezone as UTC", async () => {
      const { decrypt } = await import("#shared/crypto/encryption.ts");
      const input = "2099-06-15T14:30";
      const result = await writeClosesAt(input);
      const decrypted = await decrypt(result as unknown as string);
      expect(decrypted).toBe(new Date(`${input}Z`).toISOString());
    });

    test("handles already-normalized ISO string", async () => {
      const { decrypt } = await import("#shared/crypto/encryption.ts");
      const result = await writeClosesAt("2099-06-15T14:30:00.000Z");
      const decrypted = await decrypt(result as unknown as string);
      expect(decrypted).toBe("2099-06-15T14:30:00.000Z");
    });

    test("normalizes timezone offset to UTC", async () => {
      const { decrypt } = await import("#shared/crypto/encryption.ts");
      const input = "2099-06-15T14:30:00-05:00";
      const result = await writeClosesAt(input);
      const decrypted = await decrypt(result as unknown as string);
      expect(decrypted).toBe(new Date(input).toISOString());
    });
  });

  describe("writeEventDate", () => {
    test("encrypts empty string for no date", async () => {
      const { decrypt } = await import("#shared/crypto/encryption.ts");
      const result = await writeEventDate("");
      expect(typeof result).toBe("string");
      expect(result).not.toBe("");
      const decrypted = await decrypt(result);
      expect(decrypted).toBe("");
    });

    test("normalizes datetime-local string without timezone as UTC", async () => {
      const { decrypt } = await import("#shared/crypto/encryption.ts");
      const input = "2026-06-15T14:00";
      const result = await writeEventDate(input);
      const decrypted = await decrypt(result);
      expect(decrypted).toBe(new Date(`${input}Z`).toISOString());
    });

    test("handles already-normalized ISO string", async () => {
      const { decrypt } = await import("#shared/crypto/encryption.ts");
      const result = await writeEventDate("2026-06-15T14:00:00.000Z");
      const decrypted = await decrypt(result);
      expect(decrypted).toBe("2026-06-15T14:00:00.000Z");
    });

    test("normalizes timezone offset to UTC", async () => {
      const { decrypt } = await import("#shared/crypto/encryption.ts");
      const input = "2026-06-15T14:00:00+02:00";
      const result = await writeEventDate(input);
      const decrypted = await decrypt(result);
      expect(decrypted).toBe(new Date(input).toISOString());
    });

    test("returns empty string for invalid datetime", async () => {
      const errorSpy = spy(console, "error");
      const { decrypt } = await import("#shared/crypto/encryption.ts");
      const result = await writeEventDate("not-a-dateZ");
      const decrypted = await decrypt(result);
      expect(decrypted).toBe("");
      expect(errorSpy.calls.length).toBeGreaterThan(0);
      errorSpy.restore();
    });
  });

  describe("event date read transform", () => {
    test("returns empty string for no-date event", async () => {
      const event = await eventsTable.insert({
        date: "",
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test",
        slug: "test-date-read-1",
        slugIndex: await computeSlugIndex("test-date-read-1"),
      });
      const saved = await getEventWithCount(event.id);
      expect(saved?.date).toBe("");
    });

    test("returns normalized ISO string for valid datetime", async () => {
      const event = await eventsTable.insert({
        date: "2026-06-15T14:00",
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test",
        slug: "test-date-read-2",
        slugIndex: await computeSlugIndex("test-date-read-2"),
      });
      const saved = await getEventWithCount(event.id);
      expect(saved?.date).toBe("2026-06-15T14:00:00.000Z");
    });
  });

  describe("closes_at read transform", () => {
    test("returns null for no-deadline event", async () => {
      const event = await eventsTable.insert({
        closesAt: "",
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test",
        slug: "test-read-1",
        slugIndex: await computeSlugIndex("test-read-1"),
      });
      const saved = await getEventWithCount(event.id);
      expect(saved?.closes_at).toBeNull();
    });

    test("returns normalized ISO string for valid datetime", async () => {
      const event = await eventsTable.insert({
        closesAt: "2099-12-31T23:59",
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test",
        slug: "test-read-2",
        slugIndex: await computeSlugIndex("test-read-2"),
      });
      const saved = await getEventWithCount(event.id);
      expect(saved?.closes_at).toBe("2099-12-31T23:59:00.000Z");
    });
  });

  describe("bookable_days read transform", () => {
    test("returns empty array when DB contains non-array JSON", async () => {
      const event = await eventsTable.insert({
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test-bd",
        slug: "test-bd-1",
        slugIndex: await computeSlugIndex("test-bd-1"),
      });
      await getDb().execute({
        args: ['"not-an-array"', event.id],
        sql: "UPDATE events SET bookable_days = ? WHERE id = ?",
      });
      const saved = await getEventWithCount(event.id);
      expect(saved?.bookable_days).toEqual([]);
    });
  });
});
