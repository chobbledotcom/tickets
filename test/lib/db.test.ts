import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import {
  createAttendee,
  createEvent,
  generatePassword,
  getAllEvents,
  getAttendees,
  getDb,
  getEvent,
  getEventWithCount,
  getOrCreateAdminPassword,
  getSetting,
  hasAvailableSpots,
  initDb,
  setDb,
  setSetting,
  verifyAdminPassword,
} from "#lib/db.ts";

describe("db", () => {
  beforeEach(async () => {
    const client = createClient({ url: ":memory:" });
    setDb(client);
    await initDb();
  });

  afterEach(() => {
    setDb(null);
  });

  describe("generatePassword", () => {
    test("generates 16 character password", () => {
      const password = generatePassword();
      expect(password.length).toBe(16);
    });

    test("generates alphanumeric password", () => {
      const password = generatePassword();
      expect(password).toMatch(/^[a-zA-Z0-9]+$/);
    });

    test("generates different passwords each time", () => {
      const p1 = generatePassword();
      const p2 = generatePassword();
      expect(p1).not.toBe(p2);
    });
  });

  describe("settings", () => {
    test("getSetting returns null for missing key", async () => {
      const value = await getSetting("missing");
      expect(value).toBeNull();
    });

    test("setSetting and getSetting work together", async () => {
      await setSetting("test_key", "test_value");
      const value = await getSetting("test_key");
      expect(value).toBe("test_value");
    });

    test("setSetting overwrites existing value", async () => {
      await setSetting("key", "value1");
      await setSetting("key", "value2");
      const value = await getSetting("key");
      expect(value).toBe("value2");
    });
  });

  describe("admin password", () => {
    test("getOrCreateAdminPassword creates password on first call", async () => {
      const password = await getOrCreateAdminPassword();
      expect(password.length).toBe(16);
    });

    test("getOrCreateAdminPassword returns same password on subsequent calls", async () => {
      const p1 = await getOrCreateAdminPassword();
      const p2 = await getOrCreateAdminPassword();
      expect(p1).toBe(p2);
    });

    test("verifyAdminPassword returns true for correct password", async () => {
      const password = await getOrCreateAdminPassword();
      const result = await verifyAdminPassword(password);
      expect(result).toBe(true);
    });

    test("verifyAdminPassword returns false for wrong password", async () => {
      await getOrCreateAdminPassword();
      const result = await verifyAdminPassword("wrong");
      expect(result).toBe(false);
    });
  });

  describe("events", () => {
    test("createEvent creates event with correct properties", async () => {
      const event = await createEvent(
        "Test Event",
        "Test Description",
        100,
        "https://example.com/thanks",
      );

      expect(event.id).toBe(1);
      expect(event.name).toBe("Test Event");
      expect(event.description).toBe("Test Description");
      expect(event.max_attendees).toBe(100);
      expect(event.thank_you_url).toBe("https://example.com/thanks");
      expect(event.created).toBeDefined();
    });

    test("getAllEvents returns empty array when no events", async () => {
      const events = await getAllEvents();
      expect(events).toEqual([]);
    });

    test("getAllEvents returns events with attendee count", async () => {
      await createEvent("Event 1", "Desc 1", 50, "https://example.com");
      await createEvent("Event 2", "Desc 2", 100, "https://example.com");

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
      const created = await createEvent(
        "Test",
        "Desc",
        50,
        "https://example.com",
      );
      const fetched = await getEvent(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched?.name).toBe("Test");
    });

    test("getEventWithCount returns null for missing event", async () => {
      const event = await getEventWithCount(999);
      expect(event).toBeNull();
    });

    test("getEventWithCount returns event with count", async () => {
      const created = await createEvent(
        "Test",
        "Desc",
        50,
        "https://example.com",
      );
      const fetched = await getEventWithCount(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched?.attendee_count).toBe(0);
    });
  });

  describe("attendees", () => {
    test("createAttendee creates attendee", async () => {
      const event = await createEvent(
        "Event",
        "Desc",
        50,
        "https://example.com",
      );
      const attendee = await createAttendee(
        event.id,
        "John Doe",
        "john@example.com",
      );

      expect(attendee.id).toBe(1);
      expect(attendee.event_id).toBe(event.id);
      expect(attendee.name).toBe("John Doe");
      expect(attendee.email).toBe("john@example.com");
      expect(attendee.created).toBeDefined();
    });

    test("getAttendees returns empty array when no attendees", async () => {
      const event = await createEvent(
        "Event",
        "Desc",
        50,
        "https://example.com",
      );
      const attendees = await getAttendees(event.id);
      expect(attendees).toEqual([]);
    });

    test("getAttendees returns attendees for event", async () => {
      const event = await createEvent(
        "Event",
        "Desc",
        50,
        "https://example.com",
      );
      await createAttendee(event.id, "John", "john@example.com");
      await createAttendee(event.id, "Jane", "jane@example.com");

      const attendees = await getAttendees(event.id);
      expect(attendees.length).toBe(2);
    });

    test("attendee count reflects in getEventWithCount", async () => {
      const event = await createEvent(
        "Event",
        "Desc",
        50,
        "https://example.com",
      );
      await createAttendee(event.id, "John", "john@example.com");

      const fetched = await getEventWithCount(event.id);
      expect(fetched?.attendee_count).toBe(1);
    });

    test("attendee count reflects in getAllEvents", async () => {
      const event = await createEvent(
        "Event",
        "Desc",
        50,
        "https://example.com",
      );
      await createAttendee(event.id, "John", "john@example.com");
      await createAttendee(event.id, "Jane", "jane@example.com");

      const events = await getAllEvents();
      expect(events[0]?.attendee_count).toBe(2);
    });
  });

  describe("hasAvailableSpots", () => {
    test("returns false for non-existent event", async () => {
      const result = await hasAvailableSpots(999);
      expect(result).toBe(false);
    });

    test("returns true when spots available", async () => {
      const event = await createEvent(
        "Event",
        "Desc",
        2,
        "https://example.com",
      );
      const result = await hasAvailableSpots(event.id);
      expect(result).toBe(true);
    });

    test("returns true when some spots taken", async () => {
      const event = await createEvent(
        "Event",
        "Desc",
        2,
        "https://example.com",
      );
      await createAttendee(event.id, "John", "john@example.com");

      const result = await hasAvailableSpots(event.id);
      expect(result).toBe(true);
    });

    test("returns false when event is full", async () => {
      const event = await createEvent(
        "Event",
        "Desc",
        2,
        "https://example.com",
      );
      await createAttendee(event.id, "John", "john@example.com");
      await createAttendee(event.id, "Jane", "jane@example.com");

      const result = await hasAvailableSpots(event.id);
      expect(result).toBe(false);
    });
  });

  describe("getDb", () => {
    test("creates client when db is null", () => {
      setDb(null);
      const originalDbUrl = process.env.DB_URL;
      process.env.DB_URL = ":memory:";

      const client = getDb();
      expect(client).toBeDefined();

      process.env.DB_URL = originalDbUrl;
    });

    test("returns existing client when db is set", () => {
      const client1 = getDb();
      const client2 = getDb();
      expect(client1).toBe(client2);
    });

    test("throws error when DB_URL is not set", () => {
      setDb(null);
      const originalDbUrl = process.env.DB_URL;
      delete process.env.DB_URL;

      expect(() => getDb()).toThrow("DB_URL environment variable is required");

      process.env.DB_URL = originalDbUrl;
    });
  });
});
