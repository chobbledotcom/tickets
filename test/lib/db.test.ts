import { afterEach, beforeEach, describe, expect, jest, test } from "#test-compat";
import { createClient } from "@libsql/client";
import { decryptWithKey, importPrivateKey } from "#lib/crypto.ts";
import {
  getAllActivityLog,
  getEventActivityLog,
  logActivity,
} from "#lib/db/activityLog.ts";
import {
  createAttendeeAtomic,
  decryptAttendees,
  deleteAttendee,
  getAttendee,
  getAttendeesRaw,
  hasAvailableSpots,
} from "#lib/db/attendees.ts";
import { getDb, setDb } from "#lib/db/client.ts";
import {
  deleteEvent,
  eventsTable,
  getAllEvents,
  getEvent,
  getEventWithCount,
} from "#lib/db/events.ts";
import {
  clearLoginAttempts,
  isLoginRateLimited,
  recordFailedLogin,
} from "#lib/db/login-attempts.ts";
import { initDb, LATEST_UPDATE, resetDatabase } from "#lib/db/migrations/index.ts";
import {
  createSession,
  deleteAllSessions,
  deleteOtherSessions,
  deleteSession,
  getAllSessions,
  getSession,
  resetSessionCache,
} from "#lib/db/sessions.ts";
import {
  CONFIG_KEYS,
  completeSetup,
  getCurrencyCodeFromDb,
  getPublicKey,
  getSetting,
  getStripeSecretKeyFromDb,
  getWrappedDataKey,
  getWrappedPrivateKey,
  hasStripeKey,
  isSetupComplete,
  setSetting,
  unwrapDataKey,
  updateAdminPassword,
  updateStripeKey,
  verifyAdminPassword,
} from "#lib/db/settings.ts";
import {
  createTestAttendee,
  createTestEvent,
  resetTestSession,
  resetTestSlugCounter,
  setupTestEncryptionKey,
  TEST_ADMIN_PASSWORD,
} from "#test-utils";

/** Helper to get private key for decrypting attendees in tests */
const getTestPrivateKey = async (): Promise<CryptoKey> => {
  const passwordHash = await verifyAdminPassword(TEST_ADMIN_PASSWORD);
  if (!passwordHash) throw new Error("Test setup failed: invalid password");
  const dataKey = await unwrapDataKey(passwordHash);
  if (!dataKey) throw new Error("Test setup failed: could not unwrap data key");
  const wrappedPrivateKey = await getWrappedPrivateKey();
  if (!wrappedPrivateKey)
    throw new Error("Test setup failed: no wrapped private key");
  const privateKeyJwk = await decryptWithKey(wrappedPrivateKey, dataKey);
  return importPrivateKey(privateKeyJwk);
};

describe("db", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    resetTestSession();
    setupTestEncryptionKey();
    const client = createClient({ url: ":memory:" });
    setDb(client);
    await initDb();
    // Complete setup to have encryption keys available
    await completeSetup(TEST_ADMIN_PASSWORD, "GBP");
  });

  afterEach(() => {
    setDb(null);
  });

  describe("getDb", () => {
    test("throws error when DB_URL is not set", () => {
      setDb(null);
      const originalDbUrl = Deno.env.get("DB_URL");
      Deno.env.delete("DB_URL");

      try {
        expect(() => getDb()).toThrow(
          "DB_URL environment variable is required",
        );
      } finally {
        if (originalDbUrl) {
          Deno.env.set("DB_URL", originalDbUrl);
        }
      }
    });
  });

  describe("initDb version check", () => {
    test("LATEST_UPDATE constant is exported", () => {
      expect(typeof LATEST_UPDATE).toBe("string");
      expect(LATEST_UPDATE.length).toBeGreaterThan(0);
    });

    test("initDb stores latest_db_update in settings", async () => {
      const result = await getDb().execute(
        "SELECT value FROM settings WHERE key = 'latest_db_update'",
      );
      expect(result.rows[0]?.value).toBe(LATEST_UPDATE);
    });

    test("initDb can be called multiple times safely", async () => {
      // initDb was already called in beforeEach, call it again
      await initDb();

      // Verify tables still exist and work
      const events = await getAllEvents();
      expect(events).toEqual([]);
    });

    test("initDb bails early when database is up to date", async () => {
      // initDb was already called and stored LATEST_UPDATE
      // Calling it again should bail early without error
      const startTime = performance.now();
      await initDb();
      const duration = performance.now() - startTime;

      // Should be very fast since it bails early (typically < 5ms)
      // We just check it completes without error
      expect(duration).toBeLessThan(100);
    });
  });

  describe("resetDatabase", () => {
    test("drops all tables", async () => {
      // Create some data first
      await createTestEvent({
        slug: "test-event",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      await createSession("test-token", "test-csrf", Date.now() + 1000);

      // Reset the database
      await resetDatabase();

      // Verify tables are gone by checking that they don't exist
      const client = getDb();

      // Check that events table was dropped
      const tablesResult = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='table'",
      );
      const tableNames = tablesResult.rows.map((r) => r.name);
      expect(tableNames).not.toContain("events");
      expect(tableNames).not.toContain("attendees");
      expect(tableNames).not.toContain("sessions");
      expect(tableNames).not.toContain("settings");
      expect(tableNames).not.toContain("login_attempts");
      expect(tableNames).not.toContain("processed_payments");
      expect(tableNames).not.toContain("activity_log");
    });

    test("can reinitialize database after reset", async () => {
      // Reset and reinitialize
      await resetDatabase();
      await initDb();

      // Verify we can create new data
      await completeSetup(TEST_ADMIN_PASSWORD, "USD");
      const event = await createTestEvent({
        slug: "new-event",
        maxAttendees: 25,
        thankYouUrl: "https://example.com",
      });

      expect(event.id).toBe(1);
      expect(event.slug).toBe("new-event");
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
    test("completeSetup sets all config values and generates key hierarchy", async () => {
      await completeSetup("mypassword", "USD");

      expect(await isSetupComplete()).toBe(true);
      // Password is now hashed, verify it returns the hash on success
      const hash = await verifyAdminPassword("mypassword");
      expect(hash).toBeTruthy();
      expect(await getCurrencyCodeFromDb()).toBe("USD");

      // Key hierarchy should be generated
      expect(await getPublicKey()).toBeTruthy();
      expect(await getWrappedDataKey()).toBeTruthy();
      expect(await getWrappedPrivateKey()).toBeTruthy();
    });

    test("CONFIG_KEYS contains expected keys", () => {
      expect(CONFIG_KEYS.ADMIN_PASSWORD).toBe("admin_password");
      expect(CONFIG_KEYS.CURRENCY_CODE).toBe("currency_code");
      expect(CONFIG_KEYS.SETUP_COMPLETE).toBe("setup_complete");
      expect(CONFIG_KEYS.WRAPPED_DATA_KEY).toBe("wrapped_data_key");
      expect(CONFIG_KEYS.WRAPPED_PRIVATE_KEY).toBe("wrapped_private_key");
      expect(CONFIG_KEYS.PUBLIC_KEY).toBe("public_key");
      expect(CONFIG_KEYS.STRIPE_SECRET_KEY).toBe("stripe_secret_key");
    });

    test("getCurrencyCodeFromDb returns GBP by default", async () => {
      expect(await getCurrencyCodeFromDb()).toBe("GBP");
    });
  });

  describe("stripe key", () => {
    test("hasStripeKey returns false when not set", async () => {
      expect(await hasStripeKey()).toBe(false);
    });

    test("hasStripeKey returns true after setting key", async () => {
      await updateStripeKey("sk_test_123");
      expect(await hasStripeKey()).toBe(true);
    });

    test("getStripeSecretKeyFromDb returns null when not set", async () => {
      expect(await getStripeSecretKeyFromDb()).toBeNull();
    });

    test("getStripeSecretKeyFromDb returns decrypted key after setting", async () => {
      await updateStripeKey("sk_test_secret_key");
      const key = await getStripeSecretKeyFromDb();
      expect(key).toBe("sk_test_secret_key");
    });

    test("updateStripeKey stores key encrypted", async () => {
      await updateStripeKey("sk_test_encrypted");
      // Verify the raw value in DB is encrypted (starts with enc:1:)
      const rawValue = await getSetting(CONFIG_KEYS.STRIPE_SECRET_KEY);
      expect(rawValue).toMatch(/^enc:1:/);
      // But getStripeSecretKeyFromDb returns decrypted
      expect(await getStripeSecretKeyFromDb()).toBe("sk_test_encrypted");
    });

    test("updateStripeKey overwrites existing key", async () => {
      await updateStripeKey("sk_test_first");
      expect(await getStripeSecretKeyFromDb()).toBe("sk_test_first");

      await updateStripeKey("sk_test_second");
      expect(await getStripeSecretKeyFromDb()).toBe("sk_test_second");
    });
  });

  describe("admin password", () => {
    test("verifyAdminPassword returns hash for correct password", async () => {
      await completeSetup("testpassword123", "GBP");
      const result = await verifyAdminPassword("testpassword123");
      expect(result).toBeTruthy();
      expect(result).toContain("pbkdf2:");
    });

    test("verifyAdminPassword returns null for wrong password", async () => {
      await completeSetup("testpassword123", "GBP");
      const result = await verifyAdminPassword("wrong");
      expect(result).toBeNull();
    });

    test("verifyAdminPassword returns null when no password set", async () => {
      // Don't set any password
      const result = await verifyAdminPassword("anypassword");
      expect(result).toBeNull();
    });

    test("updateAdminPassword re-wraps DATA_KEY with new KEK", async () => {
      await completeSetup("oldpassword123", "GBP");
      const oldWrappedKey = await getWrappedDataKey();

      const success = await updateAdminPassword(
        "oldpassword123",
        "newpassword456",
      );
      expect(success).toBe(true);

      // Wrapped key should be different (re-wrapped with new KEK)
      const newWrappedKey = await getWrappedDataKey();
      expect(newWrappedKey).not.toBe(oldWrappedKey);

      // Old password should no longer work
      expect(await verifyAdminPassword("oldpassword123")).toBeNull();

      // New password should work
      expect(await verifyAdminPassword("newpassword456")).toBeTruthy();
    });

    test("updateAdminPassword fails with wrong old password", async () => {
      await completeSetup("correctpassword", "GBP");

      const success = await updateAdminPassword("wrongpassword", "newpassword");
      expect(success).toBe(false);

      // Original password should still work
      expect(await verifyAdminPassword("correctpassword")).toBeTruthy();
    });

    test("password change allows decryption of both old and new attendee records", async () => {
      const newPassword = "newpassword456";

      // Setup with TEST_ADMIN_PASSWORD so createTestEvent works
      await completeSetup(TEST_ADMIN_PASSWORD, "GBP");

      // Create an event via REST API
      const event = await createTestEvent({
        slug: "password-test-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com/thanks",
      });

      // Create an attendee BEFORE password change
      const beforeResult = await createAttendeeAtomic(
        event.id,
        "Alice Before",
        "alice@example.com",
        "pi_before_change",
      );
      if (!beforeResult.success) throw new Error("Failed to create attendee");
      const attendeeBefore = beforeResult.attendee;

      // Change the password
      const changeSuccess = await updateAdminPassword(TEST_ADMIN_PASSWORD, newPassword);
      expect(changeSuccess).toBe(true);

      // Create an attendee AFTER password change
      const afterResult = await createAttendeeAtomic(
        event.id,
        "Bob After",
        "bob@example.com",
        "pi_after_change",
      );
      if (!afterResult.success) throw new Error("Failed to create attendee");
      const attendeeAfter = afterResult.attendee;

      // Get the private key using the NEW password
      const newPasswordHash = await verifyAdminPassword(newPassword);
      expect(newPasswordHash).toBeTruthy();

      const dataKey = await unwrapDataKey(newPasswordHash!);
      expect(dataKey).toBeTruthy();

      const wrappedPrivateKey = await getWrappedPrivateKey();
      expect(wrappedPrivateKey).toBeTruthy();

      const privateKeyJwk = await decryptWithKey(wrappedPrivateKey!, dataKey!);
      const privateKey = await importPrivateKey(privateKeyJwk);

      // Decrypt the attendee created BEFORE password change
      const decryptedBefore = await getAttendee(attendeeBefore.id, privateKey);
      expect(decryptedBefore).not.toBeNull();
      expect(decryptedBefore?.name).toBe("Alice Before");
      expect(decryptedBefore?.email).toBe("alice@example.com");
      expect(decryptedBefore?.stripe_payment_id).toBe("pi_before_change");

      // Decrypt the attendee created AFTER password change
      const decryptedAfter = await getAttendee(attendeeAfter.id, privateKey);
      expect(decryptedAfter).not.toBeNull();
      expect(decryptedAfter?.name).toBe("Bob After");
      expect(decryptedAfter?.email).toBe("bob@example.com");
      expect(decryptedAfter?.stripe_payment_id).toBe("pi_after_change");
    });
  });

  describe("events", () => {
    test("createEvent creates event with correct properties", async () => {
      const event = await createTestEvent({
        slug: "my-test-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com/thanks",
      });

      expect(event.id).toBe(1);
      expect(event.slug).toBe("my-test-event");
      expect(event.max_attendees).toBe(100);
      expect(event.thank_you_url).toBe("https://example.com/thanks");
      expect(event.created).toBeDefined();
      expect(event.unit_price).toBeNull();
    });

    test("createEvent creates event with unit_price", async () => {
      const event = await createTestEvent({
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
      await createTestEvent({
        slug: "event-1",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      await createTestEvent({
        slug: "event-2",
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
      const created = await createTestEvent({
        slug: "fetch-test",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const fetched = await getEvent(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched?.slug).toBe("fetch-test");
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

    test("eventsTable.update updates event properties", async () => {
      const created = await createTestEvent({
        slug: "original-event",
        maxAttendees: 50,
        thankYouUrl: "https://example.com/original",
      });

      const updated = await eventsTable.update(created.id, {
        slug: "updated-event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com/updated",
        unitPrice: 1500,
      });

      expect(updated).not.toBeNull();
      expect(updated?.slug).toBe("updated-event");
      expect(updated?.max_attendees).toBe(100);
      expect(updated?.thank_you_url).toBe("https://example.com/updated");
      expect(updated?.unit_price).toBe(1500);
    });

    test("eventsTable.update returns null for non-existent event", async () => {
      const result = await eventsTable.update(999, {
        slug: "non-existent",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      expect(result).toBeNull();
    });

    test("eventsTable.update can set unit_price to null", async () => {
      const created = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      const updated = await eventsTable.update(created.id, {
        slug: created.slug,
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: null,
      });

      expect(updated?.unit_price).toBeNull();
    });

    test("deleteEvent removes event", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      await deleteEvent(event.id);

      const fetched = await getEvent(event.id);
      expect(fetched).toBeNull();
    });

    test("deleteEvent removes all attendees for the event", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(event.id, event.slug, "John", "john@example.com");
      await createTestAttendee(event.id, event.slug, "Jane", "jane@example.com");

      await deleteEvent(event.id);

      const privateKey = await getTestPrivateKey();
      const raw = await getAttendeesRaw(event.id);
      const attendees = await decryptAttendees(raw, privateKey);
      expect(attendees).toEqual([]);
    });

    test("deleteEvent works with no attendees", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      await deleteEvent(event.id);

      const fetched = await getEvent(event.id);
      expect(fetched).toBeNull();
    });
  });

  describe("attendees", () => {
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
      await createTestAttendee(event.id, event.slug, "John", "john@example.com");
      await createTestAttendee(event.id, event.slug, "Jane", "jane@example.com");

      const privateKey = await getTestPrivateKey();
      const raw = await getAttendeesRaw(event.id);
      const attendees = await decryptAttendees(raw, privateKey);
      expect(attendees.length).toBe(2);
    });

    test("attendee count reflects in getEventWithCount", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(event.id, event.slug, "John", "john@example.com");

      const fetched = await getEventWithCount(event.id);
      expect(fetched?.attendee_count).toBe(1);
    });

    test("attendee count reflects in getAllEvents", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(event.id, event.slug, "John", "john@example.com");
      await createTestAttendee(event.id, event.slug, "Jane", "jane@example.com");

      const events = await getAllEvents();
      expect(events[0]?.attendee_count).toBe(2);
    });

    test("createAttendeeAtomic succeeds when capacity available", async () => {
      const event = await createTestEvent({
        maxAttendees: 2,
        thankYouUrl: "https://example.com",
      });

      const result = await createAttendeeAtomic(
        event.id,
        "John",
        "john@example.com",
        "pi_test",
        1,
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.attendee.name).toBe("John");
        expect(result.attendee.stripe_payment_id).toBe("pi_test");
      }
    });

    test("createAttendeeAtomic fails when capacity exceeded", async () => {
      const event = await createTestEvent({
        maxAttendees: 1,
        thankYouUrl: "https://example.com",
      });
      // Use createAttendeeAtomic to fill capacity (production code path)
      await createAttendeeAtomic(event.id, "First", "first@example.com");

      const result = await createAttendeeAtomic(
        event.id,
        "Second",
        "second@example.com",
        null,
        1,
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe("capacity_exceeded");
      }
    });

    test("createAttendeeAtomic fails when encryption key not configured", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      // Remove public key to simulate incomplete setup
      await getDb().execute({
        sql: "DELETE FROM settings WHERE key = ?",
        args: [CONFIG_KEYS.PUBLIC_KEY],
      });

      const result = await createAttendeeAtomic(
        event.id,
        "John",
        "john@example.com",
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe("encryption_error");
      }
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
      await createTestAttendee(event.id, event.slug, "John", "john@example.com");

      const result = await hasAvailableSpots(event.id);
      expect(result).toBe(true);
    });

    test("returns false when event is full", async () => {
      const event = await createTestEvent({
        maxAttendees: 2,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(event.id, event.slug, "John", "john@example.com");
      await createTestAttendee(event.id, event.slug, "Jane", "jane@example.com");

      const result = await hasAvailableSpots(event.id);
      expect(result).toBe(false);
    });
  });

  describe("getDb", () => {
    test("creates client when db is null", () => {
      setDb(null);
      const originalDbUrl = Deno.env.get("DB_URL");
      Deno.env.set("DB_URL", ":memory:");

      const client = getDb();
      expect(client).toBeDefined();

      if (originalDbUrl) {
        Deno.env.set("DB_URL", originalDbUrl);
      } else {
        Deno.env.delete("DB_URL");
      }
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
      // Token is hashed in storage, verify by csrf_token and expires
      expect(session?.csrf_token).toBe("test-csrf-token");
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

    test("getAllSessions returns all sessions ordered by expiration descending", async () => {
      const now = Date.now();
      await createSession("session1", "csrf1", now + 1000);
      await createSession("session2", "csrf2", now + 3000);
      await createSession("session3", "csrf3", now + 2000);

      const sessions = await getAllSessions();

      expect(sessions.length).toBe(3);
      // Token is hashed, verify order by csrf_token
      expect(sessions[0]?.csrf_token).toBe("csrf2"); // Newest first (highest expiry)
      expect(sessions[1]?.csrf_token).toBe("csrf3");
      expect(sessions[2]?.csrf_token).toBe("csrf1"); // Oldest last (lowest expiry)
    });

    test("getAllSessions returns empty array when no sessions", async () => {
      const sessions = await getAllSessions();
      expect(sessions).toEqual([]);
    });

    test("deleteOtherSessions removes all sessions except current", async () => {
      await createSession("current", "csrf-current", Date.now() + 10000);
      await createSession("other1", "csrf-other1", Date.now() + 10000);
      await createSession("other2", "csrf-other2", Date.now() + 10000);

      await deleteOtherSessions("current");

      const currentSession = await getSession("current");
      const other1 = await getSession("other1");
      const other2 = await getSession("other2");

      expect(currentSession).not.toBeNull();
      expect(other1).toBeNull();
      expect(other2).toBeNull();
    });

    test("deleteOtherSessions with no other sessions keeps current", async () => {
      await createSession("only-session", "csrf", Date.now() + 10000);

      await deleteOtherSessions("only-session");

      const session = await getSession("only-session");
      expect(session).not.toBeNull();
    });

    test("getSession expires cached entry after TTL", async () => {
      // Use fake timers to control Date.now()
      jest.useFakeTimers();
      const startTime = Date.now();
      jest.setSystemTime(startTime);

      // Create and cache a session
      await createSession("ttl-test", "csrf-ttl", startTime + 60000);
      const firstCall = await getSession("ttl-test");
      expect(firstCall).not.toBeNull();

      // Advance time past the 10-second TTL
      jest.setSystemTime(startTime + 11000);

      // Reset session cache to clear it, then re-cache with old timestamp
      // by manipulating time backwards to simulate an old cache entry
      resetSessionCache();

      // Re-cache the session at the original time
      jest.setSystemTime(startTime);
      await getSession("ttl-test"); // This caches with startTime

      // Now advance time past TTL again
      jest.setSystemTime(startTime + 11000);

      // This call should find the expired cache entry, delete it, and re-query DB
      const afterTtl = await getSession("ttl-test");
      expect(afterTtl).not.toBeNull();
      expect(afterTtl?.csrf_token).toBe("csrf-ttl");

      // Restore real timers
      jest.useRealTimers();
    });
  });

  describe("updateAdminPassword", () => {
    test("updates password and invalidates all sessions", async () => {
      // Set up initial password
      await completeSetup("initial-password", "GBP");

      // Create some sessions
      await createSession("session1", "csrf1", Date.now() + 10000);
      await createSession("session2", "csrf2", Date.now() + 10000);

      // Verify initial password works
      const initialValid = await verifyAdminPassword("initial-password");
      expect(initialValid).toBeTruthy();

      // Update password (new signature requires old password)
      const success = await updateAdminPassword(
        "initial-password",
        "new-password-123",
      );
      expect(success).toBe(true);

      // Verify new password works
      const newValid = await verifyAdminPassword("new-password-123");
      expect(newValid).toBeTruthy();

      // Verify old password no longer works
      const oldValid = await verifyAdminPassword("initial-password");
      expect(oldValid).toBeNull();

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

  describe("table utilities", () => {
    test("toCamelCase converts snake_case to camelCase", async () => {
      const { toCamelCase } = await import("#lib/db/table.ts");
      expect(toCamelCase("max_attendees")).toBe("maxAttendees");
      expect(toCamelCase("thank_you_url")).toBe("thankYouUrl");
      expect(toCamelCase("name")).toBe("name");
      expect(toCamelCase("stripe_payment_id")).toBe("stripePaymentId");
    });

    test("toSnakeCase converts camelCase to snake_case", async () => {
      const { toSnakeCase } = await import("#lib/db/table.ts");
      expect(toSnakeCase("maxAttendees")).toBe("max_attendees");
      expect(toSnakeCase("thankYouUrl")).toBe("thank_you_url");
      expect(toSnakeCase("name")).toBe("name");
      expect(toSnakeCase("stripePaymentId")).toBe("stripe_payment_id");
    });

    test("buildInputKeyMap creates mapping from DB columns to input keys", async () => {
      const { buildInputKeyMap } = await import("#lib/db/table.ts");
      const columns = ["max_attendees", "thank_you_url", "name"];
      const map = buildInputKeyMap(columns);
      expect(map).toEqual({
        max_attendees: "maxAttendees",
        thank_you_url: "thankYouUrl",
        name: "name",
      });
    });

    test("col.generated creates generated column definition", async () => {
      const { col } = await import("#lib/db/table.ts");
      const def = col.generated<number>();
      expect(def.generated).toBe(true);
    });

    test("col.withDefault creates column with default", async () => {
      const { col } = await import("#lib/db/table.ts");
      const def = col.withDefault(() => "default-value");
      expect(def.default?.()).toBe("default-value");
    });

    test("col.simple creates empty column definition", async () => {
      const { col } = await import("#lib/db/table.ts");
      const def = col.simple<string>();
      expect(def).toEqual({});
    });

    test("col.transform creates column with custom transforms", async () => {
      const { col } = await import("#lib/db/table.ts");
      const write = (v: string) => v.toUpperCase();
      const read = (v: string) => v.toLowerCase();
      const def = col.transform(write, read);
      expect(def.write?.("hello")).toBe("HELLO");
      expect(def.read?.("HELLO")).toBe("hello");
    });

    test("col.encrypted creates column with encrypt/decrypt transforms", async () => {
      const { col } = await import("#lib/db/table.ts");
      const encrypt = (v: string) => Promise.resolve(`enc:${v}`);
      const decrypt = (v: string) => Promise.resolve(v.replace("enc:", ""));
      const def = col.encrypted(encrypt, decrypt);
      expect(await def.write?.("hello")).toBe("enc:hello");
      expect(await def.read?.("enc:hello")).toBe("hello");
    });

    test("col.encryptedNullable handles null values", async () => {
      const { col } = await import("#lib/db/table.ts");
      const encrypt = (v: string) => Promise.resolve(`enc:${v}`);
      const decrypt = (v: string) => Promise.resolve(v.replace("enc:", ""));
      const def = col.encryptedNullable(encrypt, decrypt);
      expect(await def.write?.(null)).toBe(null);
      expect(await def.read?.(null)).toBe(null);
      expect(await def.write?.("hello")).toBe("enc:hello");
      expect(await def.read?.("enc:hello")).toBe("hello");
    });

    test("defineTable.findAll returns all rows", async () => {
      const { col, defineTable } = await import("#lib/db/table.ts");

      // Create a simple test table
      type TestRow = { id: number; name: string };
      type TestInput = { name: string };
      const testTable = defineTable<TestRow, TestInput>({
        name: "events",
        primaryKey: "id",
        schema: {
          id: col.generated<number>(),
          name: col.simple<string>(),
        },
      });

      // Create some test events directly
      await createTestEvent({
        slug: "event-1",
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
      });
      await createTestEvent({
        slug: "event-2",
        maxAttendees: 20,
        thankYouUrl: "https://example.com",
      });

      // Use findAll to get all rows
      const rows = await testTable.findAll();
      expect(rows.length).toBe(2);
    });

    test("defineTable.update with no changes returns existing row", async () => {
      const { col, defineTable } = await import("#lib/db/table.ts");

      // Create an event first
      const event = await createTestEvent({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
      });

      // Create a table with only optional fields in input
      type TestRow = { id: number; name: string };
      type TestInput = { name?: string };
      const testTable = defineTable<TestRow, TestInput>({
        name: "events",
        primaryKey: "id",
        schema: {
          id: col.generated<number>(),
          name: col.simple<string>(),
        },
      });

      // Update with empty input should return the existing row
      const result = await testTable.update(event.id, {});
      expect(result).not.toBeNull();
      expect(result?.id).toBe(event.id);
    });

    test("defineTable with write transform transforms values on insert", async () => {
      const { col, defineTable } = await import("#lib/db/table.ts");
      // Create a table with a write transform that uppercases slug
      type TestRow = {
        id: number;
        slug: string;
        slug_index: string;
        created: string;
        max_attendees: number;
        thank_you_url: string;
        unit_price: number | null;
        max_quantity: number;
        webhook_url: string | null;
        active: number;
      };
      type TestInput = {
        slug: string;
        slugIndex: string;
        maxAttendees: number;
        thankYouUrl: string;
        unitPrice?: number | null;
        maxQuantity?: number;
        webhookUrl?: string | null;
        active?: number;
      };
      const testTable = defineTable<TestRow, TestInput>({
        name: "events",
        primaryKey: "id",
        schema: {
          id: col.generated<number>(),
          created: col.withDefault(() => new Date().toISOString()),
          slug: col.transform(
            (v: string) => v.toUpperCase(),
            (v: string) => v.toLowerCase(),
          ),
          slug_index: col.simple<string>(),
          max_attendees: col.simple<number>(),
          thank_you_url: col.simple<string>(),
          unit_price: col.simple<number | null>(),
          max_quantity: col.withDefault(() => 1),
          webhook_url: col.simple<string | null>(),
          active: col.withDefault(() => 1),
        },
      });

      // Insert should apply the write transform
      const row = await testTable.insert({
        slug: "test-event",
        slugIndex: "test-index",
        maxAttendees: 10,
        thankYouUrl: "http://test.com",
      });
      expect(row.slug).toBe("test-event"); // Returns original input value

      // But the DB should have the transformed value (read transform lowercases)
      const fromDb = await testTable.findById(row.id);
      expect(fromDb?.slug).toBe("test-event"); // Read transform lowercases the uppercased "TEST-EVENT"
    });
  });

  describe("activity log", () => {
    test("logActivity creates log entry with message", async () => {
      const entry = await logActivity("Test action");

      expect(entry.id).toBe(1);
      expect(entry.message).toBe("Test action");
      expect(entry.event_id).toBeNull();
      expect(entry.created).toBeDefined();
    });

    test("logActivity creates log entry with event ID", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const entry = await logActivity("Created event 'Test Event'", event.id);

      expect(entry.event_id).toBe(event.id);
      expect(entry.message).toBe("Created event 'Test Event'");
    });

    test("getEventActivityLog returns entries for specific event", async () => {
      const event1 = await createTestEvent({
        slug: "event-1",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const event2 = await createTestEvent({
        slug: "event-2",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      await logActivity("Action for event 1", event1.id);
      await logActivity("Another action for event 1", event1.id);
      await logActivity("Action for event 2", event2.id);

      const event1Log = await getEventActivityLog(event1.id);
      // REST API also logs "Created event", so we have 3 entries for event 1
      expect(event1Log.length).toBe(3);
      expect(event1Log[0]?.message).toBe("Another action for event 1");
      expect(event1Log[1]?.message).toBe("Action for event 1");
    });

    test("getEventActivityLog returns empty array when no entries", async () => {
      const entries = await getEventActivityLog(999);
      expect(entries).toEqual([]);
    });

    test("getEventActivityLog respects limit", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      await logActivity("Action 1", event.id);
      await logActivity("Action 2", event.id);
      await logActivity("Action 3", event.id);

      const entries = await getEventActivityLog(event.id, 2);
      expect(entries.length).toBe(2);
    });

    test("getAllActivityLog returns all entries", async () => {
      const event = await createTestEvent({
        slug: "test-event",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      await logActivity("Global action");
      await logActivity("Event action", event.id);

      const entries = await getAllActivityLog();
      // REST API logs "Created event", so we have 3 entries total
      expect(entries.length).toBe(3);
    });

    test("getAllActivityLog returns entries in descending order", async () => {
      await logActivity("First action");
      await logActivity("Second action");
      await logActivity("Third action");

      const entries = await getAllActivityLog();
      expect(entries[0]?.message).toBe("Third action");
      expect(entries[1]?.message).toBe("Second action");
      expect(entries[2]?.message).toBe("First action");
    });

    test("getAllActivityLog respects limit", async () => {
      await logActivity("Action 1");
      await logActivity("Action 2");
      await logActivity("Action 3");

      const entries = await getAllActivityLog(2);
      expect(entries.length).toBe(2);
    });
  });
});
