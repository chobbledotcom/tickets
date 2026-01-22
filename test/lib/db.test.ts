import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import {
  CONFIG_KEYS,
  completeSetup,
  createAttendee,
  createEvent,
  createSession,
  deleteAttendee,
  deleteExpiredSessions,
  deleteSession,
  generatePassword,
  getAdminPasswordFromDb,
  getAllEvents,
  getAttendee,
  getAttendees,
  getCurrencyCodeFromDb,
  getDb,
  getEvent,
  getEventWithCount,
  getOrCreateAdminPassword,
  getSession,
  getSetting,
  getStripeSecretKeyFromDb,
  hasAvailableSpots,
  initDb,
  isSetupComplete,
  setDb,
  setSetting,
  updateAttendeePayment,
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

  describe("getDb", () => {
    test("throws error when DB_URL is not set", () => {
      setDb(null);
      const originalDbUrl = process.env.DB_URL;
      delete process.env.DB_URL;

      try {
        expect(() => getDb()).toThrow(
          "DB_URL environment variable is required",
        );
      } finally {
        if (originalDbUrl) {
          process.env.DB_URL = originalDbUrl;
        }
      }
    });
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

  describe("setup", () => {
    test("isSetupComplete returns false initially", async () => {
      expect(await isSetupComplete()).toBe(false);
    });

    test("completeSetup sets all config values", async () => {
      await completeSetup("mypassword", "sk_test_123", "USD");

      expect(await isSetupComplete()).toBe(true);
      expect(await getAdminPasswordFromDb()).toBe("mypassword");
      expect(await getStripeSecretKeyFromDb()).toBe("sk_test_123");
      expect(await getCurrencyCodeFromDb()).toBe("USD");
    });

    test("completeSetup works without stripe key", async () => {
      await completeSetup("mypassword", null, "EUR");

      expect(await isSetupComplete()).toBe(true);
      expect(await getAdminPasswordFromDb()).toBe("mypassword");
      expect(await getStripeSecretKeyFromDb()).toBeNull();
      expect(await getCurrencyCodeFromDb()).toBe("EUR");
    });

    test("CONFIG_KEYS contains expected keys", () => {
      expect(CONFIG_KEYS.ADMIN_PASSWORD).toBe("admin_password");
      expect(CONFIG_KEYS.STRIPE_KEY).toBe("stripe_key");
      expect(CONFIG_KEYS.CURRENCY_CODE).toBe("currency_code");
      expect(CONFIG_KEYS.SETUP_COMPLETE).toBe("setup_complete");
    });

    test("getCurrencyCodeFromDb returns GBP by default", async () => {
      expect(await getCurrencyCodeFromDb()).toBe("GBP");
    });

    test("getAdminPasswordFromDb returns null when not set", async () => {
      expect(await getAdminPasswordFromDb()).toBeNull();
    });

    test("getStripeSecretKeyFromDb returns null when not set", async () => {
      expect(await getStripeSecretKeyFromDb()).toBeNull();
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

    test("verifyAdminPassword returns false when no password set", async () => {
      // Don't set any password
      const result = await verifyAdminPassword("anypassword");
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
      expect(event.unit_price).toBeNull();
    });

    test("createEvent creates event with unit_price", async () => {
      const event = await createEvent(
        "Paid Event",
        "Description",
        50,
        "https://example.com/thanks",
        1000,
      );

      expect(event.unit_price).toBe(1000);
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
      expect(attendee.stripe_payment_id).toBeNull();
    });

    test("createAttendee creates attendee with stripe_payment_id", async () => {
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
        "pi_test_123",
      );

      expect(attendee.stripe_payment_id).toBe("pi_test_123");
    });

    test("getAttendee returns null for missing attendee", async () => {
      const attendee = await getAttendee(999);
      expect(attendee).toBeNull();
    });

    test("getAttendee returns attendee by id", async () => {
      const event = await createEvent(
        "Event",
        "Desc",
        50,
        "https://example.com",
      );
      const created = await createAttendee(
        event.id,
        "John Doe",
        "john@example.com",
      );
      const fetched = await getAttendee(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched?.name).toBe("John Doe");
    });

    test("updateAttendeePayment updates stripe_payment_id", async () => {
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

      await updateAttendeePayment(attendee.id, "pi_updated_123");

      const updated = await getAttendee(attendee.id);
      expect(updated?.stripe_payment_id).toBe("pi_updated_123");
    });

    test("deleteAttendee removes attendee", async () => {
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

      await deleteAttendee(attendee.id);

      const fetched = await getAttendee(attendee.id);
      expect(fetched).toBeNull();
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
  });

  describe("sessions", () => {
    test("createSession and getSession work together", async () => {
      const expires = Date.now() + 1000;
      await createSession("test-token", expires);

      const session = await getSession("test-token");
      expect(session).not.toBeNull();
      expect(session?.token).toBe("test-token");
      expect(session?.expires).toBe(expires);
    });

    test("getSession returns null for missing session", async () => {
      const session = await getSession("nonexistent");
      expect(session).toBeNull();
    });

    test("deleteSession removes session", async () => {
      await createSession("delete-me", Date.now() + 1000);
      await deleteSession("delete-me");

      const session = await getSession("delete-me");
      expect(session).toBeNull();
    });

    test("deleteExpiredSessions removes expired sessions", async () => {
      await createSession("expired", Date.now() - 1000);
      await createSession("valid", Date.now() + 10000);

      await deleteExpiredSessions();

      const expiredSession = await getSession("expired");
      const validSession = await getSession("valid");

      expect(expiredSession).toBeNull();
      expect(validSession).not.toBeNull();
    });
  });
});
