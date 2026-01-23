import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import {
  CONFIG_KEYS,
  clearLoginAttempts,
  completeSetup,
  createAttendee,
  createEvent,
  createSession,
  deleteAllSessions,
  deleteAttendee,
  deleteExpiredSessions,
  deleteSession,
  getAdminPasswordFromDb,
  getAllEvents,
  getAttendee,
  getAttendees,
  getCurrencyCodeFromDb,
  getDb,
  getEvent,
  getEventWithCount,
  getSession,
  getSetting,
  getStripeSecretKeyFromDb,
  hasAvailableSpots,
  hasStripeKey,
  initDb,
  isLoginRateLimited,
  isSetupComplete,
  recordFailedLogin,
  setDb,
  setSetting,
  updateAdminPassword,
  updateAttendeePayment,
  updateEvent,
  updateStripeKey,
  verifyAdminPassword,
} from "#lib/db";
import { setupTestEncryptionKey } from "#test-utils";

describe("db", () => {
  beforeEach(async () => {
    setupTestEncryptionKey();
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
      // Password is now hashed, so verify it works instead of checking raw value
      expect(await verifyAdminPassword("mypassword")).toBe(true);
      expect(await getStripeSecretKeyFromDb()).toBe("sk_test_123");
      expect(await getCurrencyCodeFromDb()).toBe("USD");
    });

    test("completeSetup works without stripe key", async () => {
      await completeSetup("mypassword", null, "EUR");

      expect(await isSetupComplete()).toBe(true);
      // Password is now hashed, so verify it works instead of checking raw value
      expect(await verifyAdminPassword("mypassword")).toBe(true);
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

    test("hasStripeKey returns false when not set", async () => {
      expect(await hasStripeKey()).toBe(false);
    });

    test("hasStripeKey returns true when stripe key is configured", async () => {
      await completeSetup("password123", "sk_test_123", "GBP");
      expect(await hasStripeKey()).toBe(true);
    });

    test("updateStripeKey updates the stripe key", async () => {
      await completeSetup("password123", "sk_test_old", "GBP");
      expect(await getStripeSecretKeyFromDb()).toBe("sk_test_old");

      await updateStripeKey("sk_test_new");
      expect(await getStripeSecretKeyFromDb()).toBe("sk_test_new");
    });

    test("updateStripeKey sets stripe key when none exists", async () => {
      await completeSetup("password123", null, "GBP");
      expect(await hasStripeKey()).toBe(false);

      await updateStripeKey("sk_test_123");
      expect(await hasStripeKey()).toBe(true);
      expect(await getStripeSecretKeyFromDb()).toBe("sk_test_123");
    });
  });

  describe("admin password", () => {
    test("verifyAdminPassword returns true for correct password", async () => {
      await completeSetup("testpassword123", null, "GBP");
      const result = await verifyAdminPassword("testpassword123");
      expect(result).toBe(true);
    });

    test("verifyAdminPassword returns false for wrong password", async () => {
      await completeSetup("testpassword123", null, "GBP");
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
      const event = await createEvent({
        name: "Test Event",
        description: "Test Description",
        maxAttendees: 100,
        thankYouUrl: "https://example.com/thanks",
      });

      expect(event.id).toBe(1);
      expect(event.name).toBe("Test Event");
      expect(event.description).toBe("Test Description");
      expect(event.max_attendees).toBe(100);
      expect(event.thank_you_url).toBe("https://example.com/thanks");
      expect(event.created).toBeDefined();
      expect(event.unit_price).toBeNull();
    });

    test("createEvent creates event with unit_price", async () => {
      const event = await createEvent({
        name: "Paid Event",
        description: "Description",
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      expect(event.unit_price).toBe(1000);
    });

    test("getAllEvents returns empty array when no events", async () => {
      const events = await getAllEvents();
      expect(events).toEqual([]);
    });

    test("getAllEvents returns events with attendee count", async () => {
      await createEvent({
        name: "Event 1",
        description: "Desc 1",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      await createEvent({
        name: "Event 2",
        description: "Desc 2",
        maxAttendees: 100,
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
      const created = await createEvent({
        name: "Test",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const fetched = await getEvent(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched?.name).toBe("Test");
    });

    test("getEventWithCount returns null for missing event", async () => {
      const event = await getEventWithCount(999);
      expect(event).toBeNull();
    });

    test("getEventWithCount returns event with count", async () => {
      const created = await createEvent({
        name: "Test",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const fetched = await getEventWithCount(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched?.attendee_count).toBe(0);
    });

    test("updateEvent updates event properties", async () => {
      const created = await createEvent({
        name: "Original",
        description: "Original Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com/original",
      });

      const updated = await updateEvent(created.id, {
        name: "Updated",
        description: "Updated Desc",
        maxAttendees: 100,
        thankYouUrl: "https://example.com/updated",
        unitPrice: 1500,
      });

      expect(updated).not.toBeNull();
      expect(updated?.name).toBe("Updated");
      expect(updated?.description).toBe("Updated Desc");
      expect(updated?.max_attendees).toBe(100);
      expect(updated?.thank_you_url).toBe("https://example.com/updated");
      expect(updated?.unit_price).toBe(1500);
    });

    test("updateEvent returns null for non-existent event", async () => {
      const result = await updateEvent(999, {
        name: "Name",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      expect(result).toBeNull();
    });

    test("updateEvent can set unit_price to null", async () => {
      const created = await createEvent({
        name: "Paid",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      const updated = await updateEvent(created.id, {
        name: "Free Now",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: null,
      });

      expect(updated?.unit_price).toBeNull();
    });
  });

  describe("attendees", () => {
    test("createAttendee creates attendee", async () => {
      const event = await createEvent({
        name: "Event",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
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
      const event = await createEvent({
        name: "Event",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
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
      const event = await createEvent({
        name: "Event",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
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
      const event = await createEvent({
        name: "Event",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
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
      const event = await createEvent({
        name: "Event",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
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
      const event = await createEvent({
        name: "Event",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const attendees = await getAttendees(event.id);
      expect(attendees).toEqual([]);
    });

    test("getAttendees returns attendees for event", async () => {
      const event = await createEvent({
        name: "Event",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      await createAttendee(event.id, "John", "john@example.com");
      await createAttendee(event.id, "Jane", "jane@example.com");

      const attendees = await getAttendees(event.id);
      expect(attendees.length).toBe(2);
    });

    test("attendee count reflects in getEventWithCount", async () => {
      const event = await createEvent({
        name: "Event",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      await createAttendee(event.id, "John", "john@example.com");

      const fetched = await getEventWithCount(event.id);
      expect(fetched?.attendee_count).toBe(1);
    });

    test("attendee count reflects in getAllEvents", async () => {
      const event = await createEvent({
        name: "Event",
        description: "Desc",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
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
      const event = await createEvent({
        name: "Event",
        description: "Desc",
        maxAttendees: 2,
        thankYouUrl: "https://example.com",
      });
      const result = await hasAvailableSpots(event.id);
      expect(result).toBe(true);
    });

    test("returns true when some spots taken", async () => {
      const event = await createEvent({
        name: "Event",
        description: "Desc",
        maxAttendees: 2,
        thankYouUrl: "https://example.com",
      });
      await createAttendee(event.id, "John", "john@example.com");

      const result = await hasAvailableSpots(event.id);
      expect(result).toBe(true);
    });

    test("returns false when event is full", async () => {
      const event = await createEvent({
        name: "Event",
        description: "Desc",
        maxAttendees: 2,
        thankYouUrl: "https://example.com",
      });
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
      await createSession("test-token", "test-csrf-token", expires);

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
      await createSession("delete-me", "csrf-delete", Date.now() + 1000);
      await deleteSession("delete-me");

      const session = await getSession("delete-me");
      expect(session).toBeNull();
    });

    test("deleteExpiredSessions removes expired sessions", async () => {
      await createSession("expired", "csrf-expired", Date.now() - 1000);
      await createSession("valid", "csrf-valid", Date.now() + 10000);

      await deleteExpiredSessions();

      const expiredSession = await getSession("expired");
      const validSession = await getSession("valid");

      expect(expiredSession).toBeNull();
      expect(validSession).not.toBeNull();
    });

    test("deleteAllSessions removes all sessions", async () => {
      await createSession("session1", "csrf1", Date.now() + 10000);
      await createSession("session2", "csrf2", Date.now() + 10000);
      await createSession("session3", "csrf3", Date.now() + 10000);

      await deleteAllSessions();

      const session1 = await getSession("session1");
      const session2 = await getSession("session2");
      const session3 = await getSession("session3");

      expect(session1).toBeNull();
      expect(session2).toBeNull();
      expect(session3).toBeNull();
    });
  });

  describe("updateAdminPassword", () => {
    test("updates password and invalidates all sessions", async () => {
      // Set up initial password
      await completeSetup("initial-password", null, "GBP");

      // Create some sessions
      await createSession("session1", "csrf1", Date.now() + 10000);
      await createSession("session2", "csrf2", Date.now() + 10000);

      // Verify initial password works
      const initialValid = await verifyAdminPassword("initial-password");
      expect(initialValid).toBe(true);

      // Update password
      await updateAdminPassword("new-password-123");

      // Verify new password works
      const newValid = await verifyAdminPassword("new-password-123");
      expect(newValid).toBe(true);

      // Verify old password no longer works
      const oldValid = await verifyAdminPassword("initial-password");
      expect(oldValid).toBe(false);

      // Verify all sessions were invalidated
      const session1 = await getSession("session1");
      const session2 = await getSession("session2");
      expect(session1).toBeNull();
      expect(session2).toBeNull();
    });
  });

  describe("rate limiting", () => {
    test("isLoginRateLimited returns false for new IP", async () => {
      const limited = await isLoginRateLimited("192.168.1.1");
      expect(limited).toBe(false);
    });

    test("recordFailedLogin increments attempts", async () => {
      const locked1 = await recordFailedLogin("192.168.1.2");
      expect(locked1).toBe(false);

      const locked2 = await recordFailedLogin("192.168.1.2");
      expect(locked2).toBe(false);
    });

    test("recordFailedLogin locks after 5 attempts", async () => {
      for (let i = 0; i < 4; i++) {
        const locked = await recordFailedLogin("192.168.1.3");
        expect(locked).toBe(false);
      }

      // 5th attempt should lock
      const locked = await recordFailedLogin("192.168.1.3");
      expect(locked).toBe(true);
    });

    test("isLoginRateLimited returns true when locked", async () => {
      // Lock the IP
      for (let i = 0; i < 5; i++) {
        await recordFailedLogin("192.168.1.4");
      }

      const limited = await isLoginRateLimited("192.168.1.4");
      expect(limited).toBe(true);
    });

    test("clearLoginAttempts clears attempts", async () => {
      await recordFailedLogin("192.168.1.5");
      await recordFailedLogin("192.168.1.5");

      await clearLoginAttempts("192.168.1.5");

      // After clearing, should not be limited
      const limited = await isLoginRateLimited("192.168.1.5");
      expect(limited).toBe(false);
    });

    test("isLoginRateLimited clears expired lockout", async () => {
      // Insert a record with expired lockout
      await getDb().execute({
        sql: "INSERT INTO login_attempts (ip, attempts, locked_until) VALUES (?, ?, ?)",
        args: ["192.168.1.6", 5, Date.now() - 1000],
      });

      // Should clear the expired lockout and return false
      const limited = await isLoginRateLimited("192.168.1.6");
      expect(limited).toBe(false);
    });

    test("isLoginRateLimited returns false for attempts below max without lockout", async () => {
      // Insert a record with some attempts but no lockout
      await getDb().execute({
        sql: "INSERT INTO login_attempts (ip, attempts, locked_until) VALUES (?, ?, NULL)",
        args: ["192.168.1.7", 3],
      });

      const limited = await isLoginRateLimited("192.168.1.7");
      expect(limited).toBe(false);
    });
  });
});
