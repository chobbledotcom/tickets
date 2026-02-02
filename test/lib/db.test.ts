import { afterEach, beforeEach, describe, expect, jest, test } from "#test-compat";
import { decryptWithKey, importPrivateKey } from "#lib/crypto.ts";
import {
  getAllActivityLog,
  getEventActivityLog,
  getEventWithActivityLog,
  logActivity,
} from "#lib/db/activityLog.ts";
import {
  createAttendeeAtomic,
  decryptAttendees,
  deleteAttendee,
  getAttendee,
  getAttendeesByTokens,
  getAttendeesRaw,
  hasAvailableSpots,
  updateCheckedIn,
} from "#lib/db/attendees.ts";
import { getDb, setDb } from "#lib/db/client.ts";
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
} from "#lib/db/events.ts";
import {
  clearLoginAttempts,
  isLoginRateLimited,
  recordFailedLogin,
} from "#lib/db/login-attempts.ts";
import { initDb, LATEST_UPDATE, resetDatabase } from "#lib/db/migrations/index.ts";
import {
  finalizeSession as finalizePaymentSession,
  isSessionProcessed,
  reserveSession,
  STALE_RESERVATION_MS,
} from "#lib/db/processed-payments.ts";
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
  clearPaymentProvider,
  CONFIG_KEYS,
  completeSetup,
  getCurrencyCodeFromDb,
  getPublicKey,
  getSetting,
  getStripeSecretKeyFromDb,
  getWrappedPrivateKey,
  hasStripeKey,
  isSetupComplete,
  setPaymentProvider,
  setSetting,
  updateStripeKey,
} from "#lib/db/settings.ts";
import { getUserByUsername, verifyUserPassword } from "#lib/db/users.ts";
import { deriveKEK, unwrapKey } from "#lib/crypto.ts";
import {
  createTestAttendee,
  createTestDbWithSetup,
  createTestEvent,
  invalidateTestDbCache,
  resetDb,
  resetTestSlugCounter,
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
} from "#test-utils";

/** Helper to get private key for decrypting attendees in tests */
const getTestPrivateKey = async (): Promise<CryptoKey> => {
  const user = await getUserByUsername(TEST_ADMIN_USERNAME);
  if (!user) throw new Error("Test setup failed: user not found");
  const passwordHash = await verifyUserPassword(user, TEST_ADMIN_PASSWORD);
  if (!passwordHash) throw new Error("Test setup failed: invalid password");
  if (!user.wrapped_data_key) throw new Error("Test setup failed: no wrapped data key");
  const kek = await deriveKEK(passwordHash);
  const dataKey = await unwrapKey(user.wrapped_data_key, kek);
  const wrappedPrivateKey = await getWrappedPrivateKey();
  if (!wrappedPrivateKey)
    throw new Error("Test setup failed: no wrapped private key");
  const privateKeyJwk = await decryptWithKey(wrappedPrivateKey, dataKey);
  return importPrivateKey(privateKeyJwk);
};

describe("db", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
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
        name: "Test Event",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      await createSession("test-token", "test-csrf", Date.now() + 1000, null, 1);

      // Reset the database
      await resetDatabase();
      invalidateTestDbCache();

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
      invalidateTestDbCache();
      await initDb();

      // Verify we can create new data
      await completeSetup("testadmin", TEST_ADMIN_PASSWORD, "USD");
      const event = await createTestEvent({
        name: "New Event",
        maxAttendees: 25,
        thankYouUrl: "https://example.com",
      });

      expect(event.id).toBe(1);
      expect(event.name).toBe("New Event");
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
      // Delete existing user from createTestDbWithSetup to test fresh setup
      await getDb().execute("DELETE FROM users");
      await getDb().execute("DELETE FROM settings");
      await completeSetup("setupuser", "mypassword", "USD");

      expect(await isSetupComplete()).toBe(true);
      // Password is now stored on the user row, verify via user-based API
      const user = await getUserByUsername("setupuser");
      expect(user).not.toBeNull();
      const hash = await verifyUserPassword(user!, "mypassword");
      expect(hash).toBeTruthy();
      expect(hash).toContain("pbkdf2:");
      expect(await getCurrencyCodeFromDb()).toBe("USD");

      // Key hierarchy should be generated
      expect(await getPublicKey()).toBeTruthy();
      expect(user!.wrapped_data_key).toBeTruthy();
      expect(await getWrappedPrivateKey()).toBeTruthy();
    });

    test("CONFIG_KEYS contains expected keys", () => {
      expect(CONFIG_KEYS.CURRENCY_CODE).toBe("currency_code");
      expect(CONFIG_KEYS.SETUP_COMPLETE).toBe("setup_complete");
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
    test("verifyUserPassword returns hash for correct password", async () => {
      // Use the user created by createTestDbWithSetup
      const user = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(user).not.toBeNull();
      const result = await verifyUserPassword(user!, TEST_ADMIN_PASSWORD);
      expect(result).toBeTruthy();
      expect(result).toContain("pbkdf2:");
    });

    test("verifyUserPassword returns null for wrong password", async () => {
      const user = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(user).not.toBeNull();
      const result = await verifyUserPassword(user!, "wrong");
      expect(result).toBeNull();
    });

    test("updateUserPassword re-wraps DATA_KEY with new KEK", async () => {
      // Use the user from createTestDbWithSetup
      const user = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(user).not.toBeNull();
      const oldWrappedKey = user!.wrapped_data_key;

      const oldHash = await verifyUserPassword(user!, TEST_ADMIN_PASSWORD);
      expect(oldHash).toBeTruthy();

      const { updateUserPassword } = await import("#lib/db/settings.ts");
      const success = await updateUserPassword(
        user!.id,
        oldHash!,
        user!.wrapped_data_key!,
        "newpassword456",
      );
      expect(success).toBe(true);

      // Wrapped key should be different (re-wrapped with new KEK)
      const updatedUser = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(updatedUser!.wrapped_data_key).not.toBe(oldWrappedKey);

      // Old password should no longer work
      expect(await verifyUserPassword(updatedUser!, TEST_ADMIN_PASSWORD)).toBeNull();

      // New password should work
      expect(await verifyUserPassword(updatedUser!, "newpassword456")).toBeTruthy();
    });

    test("updateUserPassword fails with wrong old password hash", async () => {
      const user = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(user).not.toBeNull();

      const { updateUserPassword } = await import("#lib/db/settings.ts");
      // Pass a bogus password hash - KEK derivation will produce wrong key
      const success = await updateUserPassword(
        user!.id,
        "pbkdf2:bogus:hash",
        user!.wrapped_data_key!,
        "newpassword",
      );
      expect(success).toBe(false);

      // Original password should still work
      const unchanged = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(await verifyUserPassword(unchanged!, TEST_ADMIN_PASSWORD)).toBeTruthy();
    });

    test("password change allows decryption of both old and new attendee records", async () => {
      const newPassword = "newpassword456";

      // Use the user from createTestDbWithSetup (TEST_ADMIN_PASSWORD)
      // Create an event via REST API
      const event = await createTestEvent({
        name: "Password Test Event",
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

      // Change the password using user-based API
      const user = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(user).not.toBeNull();
      const oldHash = await verifyUserPassword(user!, TEST_ADMIN_PASSWORD);
      expect(oldHash).toBeTruthy();

      const { updateUserPassword } = await import("#lib/db/settings.ts");
      const changeSuccess = await updateUserPassword(
        user!.id,
        oldHash!,
        user!.wrapped_data_key!,
        newPassword,
      );
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
      const updatedUser = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(updatedUser).not.toBeNull();
      const newPasswordHash = await verifyUserPassword(updatedUser!, newPassword);
      expect(newPasswordHash).toBeTruthy();

      const kek = await deriveKEK(newPasswordHash!);
      const dataKey = await unwrapKey(updatedUser!.wrapped_data_key!, kek);

      const wrappedPrivateKey = await getWrappedPrivateKey();
      expect(wrappedPrivateKey).toBeTruthy();

      const privateKeyJwk = await decryptWithKey(wrappedPrivateKey!, dataKey);
      const privateKey = await importPrivateKey(privateKeyJwk);

      // Decrypt the attendee created BEFORE password change
      const decryptedBefore = await getAttendee(attendeeBefore.id, privateKey);
      expect(decryptedBefore).not.toBeNull();
      expect(decryptedBefore?.name).toBe("Alice Before");
      expect(decryptedBefore?.email).toBe("alice@example.com");
      expect(decryptedBefore?.payment_id).toBe("pi_before_change");

      // Decrypt the attendee created AFTER password change
      const decryptedAfter = await getAttendee(attendeeAfter.id, privateKey);
      expect(decryptedAfter).not.toBeNull();
      expect(decryptedAfter?.name).toBe("Bob After");
      expect(decryptedAfter?.email).toBe("bob@example.com");
      expect(decryptedAfter?.payment_id).toBe("pi_after_change");
    });
  });

  describe("events", () => {
    test("createEvent creates event with correct properties", async () => {
      const event = await createTestEvent({
        name: "My Test Event",
        maxAttendees: 100,
        thankYouUrl: "https://example.com/thanks",
      });

      expect(event.id).toBe(1);
      expect(event.name).toBe("My Test Event");
      expect(event.slug).toBeDefined();
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

    test("createEvent stores and retrieves description", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        description: "A test description",
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
        name: "Event One",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      await createTestEvent({
        name: "Event Two",
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
        name: "Fetch Test",
        maxAttendees: 50,
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

    test("eventsTable.update updates event properties", async () => {
      const created = await createTestEvent({
        name: "Original Event",
        maxAttendees: 50,
        thankYouUrl: "https://example.com/original",
      });

      const updated = await eventsTable.update(created.id, {
        name: "Updated Event",
        slug: created.slug,
        slugIndex: created.slug_index,
        maxAttendees: 100,
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
        name: "Non Existent",
        slug: "non-existent",
        slugIndex: "non-existent",
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
        name: created.name,
        slug: created.slug,
        slugIndex: created.slug_index,
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

    test("isSlugTaken with excludeEventId excludes that event", async () => {
      const event = await createTestEvent({
        name: "Slug Taken Test",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      // Slug is taken when checking without exclusion
      const taken = await isSlugTaken(event.slug);
      expect(taken).toBe(true);

      // Slug is not taken when excluding the event that owns it
      const notTaken = await isSlugTaken(event.slug, event.id);
      expect(notTaken).toBe(false);
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
        expect(result.attendee.payment_id).toBe("pi_test");
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
      await createSession("test-token", "test-csrf-token", expires, null, 1);

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
      await createSession("delete-me", "csrf-delete", Date.now() + 1000, null, 1);
      await deleteSession("delete-me");

      const session = await getSession("delete-me");
      expect(session).toBeNull();
    });

    test("deleteAllSessions removes all sessions", async () => {
      await createSession("session1", "csrf1", Date.now() + 10000, null, 1);
      await createSession("session2", "csrf2", Date.now() + 10000, null, 1);
      await createSession("session3", "csrf3", Date.now() + 10000, null, 1);

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
      await createSession("session1", "csrf1", now + 1000, null, 1);
      await createSession("session2", "csrf2", now + 3000, null, 1);
      await createSession("session3", "csrf3", now + 2000, null, 1);

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
      await createSession("current", "csrf-current", Date.now() + 10000, null, 1);
      await createSession("other1", "csrf-other1", Date.now() + 10000, null, 1);
      await createSession("other2", "csrf-other2", Date.now() + 10000, null, 1);

      await deleteOtherSessions("current");

      const currentSession = await getSession("current");
      const other1 = await getSession("other1");
      const other2 = await getSession("other2");

      expect(currentSession).not.toBeNull();
      expect(other1).toBeNull();
      expect(other2).toBeNull();
    });

    test("deleteOtherSessions with no other sessions keeps current", async () => {
      await createSession("only-session", "csrf", Date.now() + 10000, null, 1);

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
      await createSession("ttl-test", "csrf-ttl", startTime + 60000, null, 1);
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

  describe("updateUserPassword", () => {
    test("updates password and invalidates all sessions", async () => {
      // Use user from createTestDbWithSetup
      const user = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(user).not.toBeNull();

      // Create some sessions
      await createSession("session1", "csrf1", Date.now() + 10000, null, 1);
      await createSession("session2", "csrf2", Date.now() + 10000, null, 1);

      // Verify initial password works
      const initialHash = await verifyUserPassword(user!, TEST_ADMIN_PASSWORD);
      expect(initialHash).toBeTruthy();

      // Update password using user-based API
      const { updateUserPassword } = await import("#lib/db/settings.ts");
      const success = await updateUserPassword(
        user!.id,
        initialHash!,
        user!.wrapped_data_key!,
        "new-password-123",
      );
      expect(success).toBe(true);

      // Verify new password works
      const updatedUser = await getUserByUsername(TEST_ADMIN_USERNAME);
      const newValid = await verifyUserPassword(updatedUser!, "new-password-123");
      expect(newValid).toBeTruthy();

      // Verify old password no longer works
      const oldValid = await verifyUserPassword(updatedUser!, TEST_ADMIN_PASSWORD);
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
      expect(toCamelCase("payment_id")).toBe("paymentId");
    });

    test("toSnakeCase converts camelCase to snake_case", async () => {
      const { toSnakeCase } = await import("#lib/db/table.ts");
      expect(toSnakeCase("maxAttendees")).toBe("max_attendees");
      expect(toSnakeCase("thankYouUrl")).toBe("thank_you_url");
      expect(toSnakeCase("name")).toBe("name");
      expect(toSnakeCase("paymentId")).toBe("payment_id");
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
        name: "Event One",
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
      });
      await createTestEvent({
        name: "Event Two",
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
        name: "Event One",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const event2 = await createTestEvent({
        name: "Event Two",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      await logActivity("Action for event 1", event1.id);
      await logActivity("Another action for event 1", event1.id);
      await logActivity("Action for event 2", event2.id);

      const event1Log = await getEventActivityLog(event1.id);
      // REST API also logs event creation, so we have 3 entries for event 1
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
        name: "Test Event",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      await logActivity("Global action");
      await logActivity("Event action", event.id);

      const entries = await getAllActivityLog();
      // REST API logs event creation, so we have 3 entries total
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

    test("getEventWithActivityLog returns event and activity log together", async () => {
      const event = await createTestEvent({
        name: "Batch Test Event",
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      await logActivity("First action", event.id);
      await logActivity("Second action", event.id);

      const result = await getEventWithActivityLog(event.id);
      expect(result).not.toBeNull();
      expect(result?.event.id).toBe(event.id);
      expect(result?.event.name).toBe("Batch Test Event");
      expect(result?.event.attendee_count).toBe(0);
      // REST API logs event creation + our 2 = 3
      expect(result?.entries.length).toBe(3);
      expect(result?.entries[0]?.message).toBe("Second action");
      expect(result?.entries[1]?.message).toBe("First action");
    });

    test("getEventWithActivityLog returns null for non-existent event", async () => {
      const result = await getEventWithActivityLog(999);
      expect(result).toBeNull();
    });
  });

  describe("attendees - phone decryption", () => {
    test("decryptAttendees decrypts phone when present", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      // Create attendee with a non-empty phone to exercise the phone decryption branch
      const result = await createAttendeeAtomic(
        event.id,
        "Phone Person",
        "phone@example.com",
        null,
        1,
        "+44 7700 900000",
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.attendee.phone).toBe("+44 7700 900000");
      }

      // Decrypt and verify phone is correctly decrypted
      const privateKey = await getTestPrivateKey();
      const raw = await getAttendeesRaw(event.id);
      const attendees = await decryptAttendees(raw, privateKey);
      expect(attendees.length).toBe(1);
      expect(attendees[0]?.phone).toBe("+44 7700 900000");
      expect(attendees[0]?.name).toBe("Phone Person");
    });
  });

  describe("attendees - edge cases", () => {
    test("decryptAttendees handles empty email and phone strings", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      // Create attendee with empty email/phone via createAttendeeAtomic
      const result = await createAttendeeAtomic(
        event.id,
        "NoContact Person",
        "", // empty email
        null,
        1,
        "", // empty phone
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.attendee.email).toBe("");
        expect(result.attendee.phone).toBe("");
      }

      // Decrypt and verify empty strings come back correctly
      const privateKey = await getTestPrivateKey();
      const raw = await getAttendeesRaw(event.id);
      const attendees = await decryptAttendees(raw, privateKey);
      expect(attendees.length).toBe(1);
      expect(attendees[0]?.email).toBe("");
      expect(attendees[0]?.phone).toBe("");
    });

    test("createAttendeeAtomic stores and returns price_paid when provided", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 2500,
      });

      const result = await createAttendeeAtomic(
        event.id,
        "Paying Customer",
        "pay@example.com",
        "pi_test_price",
        1,
        "",
        2500,
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.attendee.price_paid).toBe("2500");
      }

      // Verify decrypted price_paid
      const privateKey = await getTestPrivateKey();
      const raw = await getAttendeesRaw(event.id);
      const attendees = await decryptAttendees(raw, privateKey);
      expect(attendees[0]?.price_paid).toBe("2500");
    });
  });

  describe("events - batch queries", () => {
    test("getEventWithAttendeesRaw returns event with attendees", async () => {
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(event.id, event.slug, "Alice", "alice@example.com");

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
      const attendee = await createTestAttendee(event.id, event.slug, "Bob", "bob@example.com");

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
        name: "Batch A",
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
      });
      const event2 = await createTestEvent({
        name: "Batch B",
        maxAttendees: 20,
        thankYouUrl: "https://example.com",
      });

      const results = await getEventsBySlugsBatch([event2.slug, event1.slug]);
      expect(results.length).toBe(2);
      expect(results[0]?.id).toBe(event2.id);
      expect(results[1]?.id).toBe(event1.id);
    });

    test("getEventsBySlugsBatch returns null for missing slugs", async () => {
      const event = await createTestEvent({
        name: "Exists",
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
      });

      const results = await getEventsBySlugsBatch([event.slug, "missing"]);
      expect(results.length).toBe(2);
      expect(results[0]).not.toBeNull();
      expect(results[1]).toBeNull();
    });

    test("getAttendeesByTokens returns attendees in token order", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const a1 = await createTestAttendee(event.id, event.slug, "Tok1", "tok1@example.com");
      const a2 = await createTestAttendee(event.id, event.slug, "Tok2", "tok2@example.com");

      const results = await getAttendeesByTokens([a2.ticket_token, a1.ticket_token]);
      expect(results.length).toBe(2);
      expect(results[0]?.id).toBe(a2.id);
      expect(results[1]?.id).toBe(a1.id);
    });

    test("getAttendeesByTokens returns null for missing tokens", async () => {
      const results = await getAttendeesByTokens(["nonexistent"]);
      expect(results.length).toBe(1);
      expect(results[0]).toBeNull();
    });
  });

  describe("login-attempts - expired lockout", () => {
    test("isLoginRateLimited resets expired lockout and returns false", async () => {
      // Insert a record with locked_until in the past
      await getDb().execute({
        sql: "INSERT INTO login_attempts (ip, attempts, locked_until) VALUES (?, ?, ?)",
        args: ["expired-ip-hash", 5, Date.now() - 60000],
      });

      // This uses the raw hashed IP - we need to test via the public API
      // The existing test at line 993 already covers this via isLoginRateLimited
      // But let's verify that after the expired lockout reset, new attempts work
      const ip = "192.168.99.1";

      // Lock the IP
      for (let i = 0; i < 5; i++) {
        await recordFailedLogin(ip);
      }
      expect(await isLoginRateLimited(ip)).toBe(true);

      // Simulate expired lockout by manipulating the DB directly
      await getDb().execute({
        sql: "UPDATE login_attempts SET locked_until = ? WHERE locked_until IS NOT NULL",
        args: [Date.now() - 1000],
      });

      // Should detect expired lockout, clear it, and return false
      const limited = await isLoginRateLimited(ip);
      expect(limited).toBe(false);

      // Verify the record was cleared - can fail new attempts again
      const locked = await recordFailedLogin(ip);
      expect(locked).toBe(false);
    });
  });

  describe("processed payments", () => {
    test("reserveSession succeeds on first call", async () => {
      const result = await reserveSession("sess_test_1");
      expect(result.reserved).toBe(true);
    });

    test("reserveSession returns existing when session already reserved and finalized", async () => {
      // Create an actual attendee so FK constraint is satisfied
      const event = await createTestEvent({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const attendeeResult = await createAttendeeAtomic(
        event.id,
        "Test",
        "test@example.com",
      );
      if (!attendeeResult.success) throw new Error("Failed to create attendee");

      await reserveSession("sess_dup");
      await finalizePaymentSession("sess_dup", attendeeResult.attendee.id);

      const result = await reserveSession("sess_dup");
      expect(result.reserved).toBe(false);
      if (!result.reserved) {
        expect(result.existing.attendee_id).toBe(attendeeResult.attendee.id);
      }
    });

    test("reserveSession handles UNIQUE constraint with unfinalized reservation (not stale)", async () => {
      // Reserve but don't finalize (attendee_id is NULL)
      await reserveSession("sess_unfinalized");

      // Immediately try to reserve again - should return existing (not stale yet)
      const result = await reserveSession("sess_unfinalized");
      expect(result.reserved).toBe(false);
      if (!result.reserved) {
        expect(result.existing.attendee_id).toBeNull();
      }
    });

    test("reserveSession retries when stale reservation detected", async () => {
      jest.useFakeTimers();
      const startTime = Date.now();
      jest.setSystemTime(startTime);

      // Create initial reservation
      await reserveSession("sess_stale");

      // Advance time past stale threshold
      jest.setSystemTime(startTime + STALE_RESERVATION_MS + 1000);

      // This should detect the stale reservation, delete it, and retry
      const result = await reserveSession("sess_stale");
      expect(result.reserved).toBe(true);

      jest.useRealTimers();
    });

    test("reserveSession re-throws non-unique-constraint errors", async () => {
      // Drop the table to cause a different error
      await getDb().execute("DROP TABLE processed_payments");

      try {
        await reserveSession("sess_error");
        throw new Error("should not reach here");
      } catch (e) {
        expect(String(e)).not.toContain("should not reach here");
        expect(String(e)).not.toContain("UNIQUE constraint");
      }

      // Recreate the table for subsequent tests (without FK for simplicity)
      await getDb().execute(`
        CREATE TABLE IF NOT EXISTS processed_payments (
          payment_session_id TEXT PRIMARY KEY,
          attendee_id INTEGER,
          processed_at TEXT NOT NULL,
          FOREIGN KEY (attendee_id) REFERENCES attendees(id)
        )
      `);
    });

    test("reserveSession retries when stale reservation is detected (recursive path)", async () => {
      jest.useFakeTimers();
      const startTime = Date.now();
      jest.setSystemTime(startTime);

      await reserveSession("sess_race");

      // Make it stale so it gets deleted on retry
      jest.setSystemTime(startTime + STALE_RESERVATION_MS + 1000);

      const result = await reserveSession("sess_race");
      expect(result.reserved).toBe(true);

      // Verify the session was re-reserved
      const processed = await isSessionProcessed("sess_race");
      expect(processed).not.toBeNull();

      jest.useRealTimers();
    });
  });

  describe("settings - additional coverage", () => {
    test("clearPaymentProvider removes payment provider setting", async () => {
      await setPaymentProvider("stripe");
      expect(await getSetting(CONFIG_KEYS.PAYMENT_PROVIDER)).toBe("stripe");

      await clearPaymentProvider();
      expect(await getSetting(CONFIG_KEYS.PAYMENT_PROVIDER)).toBeNull();
    });

    test("updateUserPassword returns false when dataKey unwrap fails", async () => {
      // Use the user from createTestDbWithSetup
      const user = await getUserByUsername(TEST_ADMIN_USERNAME);
      expect(user).not.toBeNull();
      const passwordHash = await verifyUserPassword(user!, TEST_ADMIN_PASSWORD);
      expect(passwordHash).toBeTruthy();

      // Pass corrupted wrapped_data_key - unwrap will fail
      const { updateUserPassword } = await import("#lib/db/settings.ts");
      const result = await updateUserPassword(
        user!.id,
        passwordHash!,
        "corrupted_wrapped_data_key",
        "newpassword",
      );
      expect(result).toBe(false);
    });
  });

  describe("table utilities - non-generated primary key", () => {
    test("insert with non-generated primary key uses empty initial row", async () => {
      const { col, defineTable } = await import("#lib/db/table.ts");

      // Create a table where the primary key is NOT generated (user-supplied)
      await getDb().execute(`
        CREATE TABLE IF NOT EXISTS kv_store (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);

      type KvRow = { key: string; value: string };
      type KvInput = { key: string; value: string };
      const kvTable = defineTable<KvRow, KvInput>({
        name: "kv_store",
        primaryKey: "key",
        schema: {
          key: col.simple<string>(),
          value: col.simple<string>(),
        },
      });

      const row = await kvTable.insert({ key: "test-key", value: "test-value" });
      expect(row.key).toBe("test-key");
      expect(row.value).toBe("test-value");

      // Verify it was actually stored
      const fetched = await kvTable.findById("test-key");
      expect(fetched).not.toBeNull();
      expect(fetched?.value).toBe("test-value");
    });
  });

  describe("table utilities - inputKeyMap fallback", () => {
    test("inputKeyMap maps single-word columns to themselves", async () => {
      const { buildInputKeyMap } = await import("#lib/db/table.ts");
      // Single-word columns like "name" should map to themselves
      // This exercises the ?? dbCol fallback since toCamelCase("name") === "name"
      const map = buildInputKeyMap(["name", "max_attendees"]);
      expect(map["name"]).toBe("name");
      expect(map["max_attendees"]).toBe("maxAttendees");
    });

    test("getProvidedColumns uses inputKeyMap fallback for single-word keys", async () => {
      // The events table has a 'slug' column - toCamelCase("slug") === "slug"
      // This tests the ?? dbCol path in getInputValue and getProvidedColumns
      const event = await createTestEvent({
        name: "Fallback Test",
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
      });

      // Update with only slug - exercises getInputValue with dbCol fallback
      const updated = await eventsTable.update(event.id, {
        name: "Updated Name",
        slug: "updated-slug",
        slugIndex: "updated-index",
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
      });
      expect(updated?.name).toBe("Updated Name");
    });
  });

  describe("table findAll", () => {
    test("returns all rows from table", async () => {
      await createTestEvent({ name: "FindAll One", maxAttendees: 10 });
      await createTestEvent({ name: "FindAll Two", maxAttendees: 20 });

      const events = await eventsTable.findAll();
      expect(events.length).toBeGreaterThanOrEqual(2);
      // Verify names are decrypted (read transforms applied)
      const names = events.map((e) => e.name);
      expect(names).toContain("FindAll One");
      expect(names).toContain("FindAll Two");
    });
  });

  describe("table update returns null for non-existent id", () => {
    test("update returns null when row does not exist", async () => {
      const result = await eventsTable.update(99999, {
        name: "Nonexistent",
        slug: "nonexistent",
        slugIndex: "idx",
        maxAttendees: 10,
      });
      expect(result).toBeNull();
    });
  });

  describe("getEventsBySlugsBatch returns null for non-existent slugs", () => {
    test("returns null entries for slugs not in database", async () => {
      const event = await createTestEvent({ name: "Batch Exists", maxAttendees: 10 });
      const results = await getEventsBySlugsBatch([event.slug, "nonexistent-slug"]);
      expect(results.length).toBe(2);
      expect(results[0]?.name).toBe("Batch Exists");
      expect(results[1]).toBeNull();
    });

    test("returns empty array for empty slug input", async () => {
      const results = await getEventsBySlugsBatch([]);
      expect(results).toEqual([]);
    });
  });

  describe("decryptAttendeeOrNull", () => {
    test("returns null when row is null", async () => {
      const { decryptAttendeeOrNull } = await import("#lib/db/attendees.ts");
      const privateKey = await getTestPrivateKey();
      const result = await decryptAttendeeOrNull(null, privateKey);
      expect(result).toBeNull();
    });
  });

  describe("updateCheckedIn", () => {
    test("updates checked_in to true for existing attendee", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(event.id, event.slug, "Check User", "check@example.com");

      await updateCheckedIn(attendee.id, true);

      const privateKey = await getTestPrivateKey();
      const rows = await getAttendeesRaw(event.id);
      const decrypted = await decryptAttendees(rows, privateKey);
      expect(decrypted[0]?.checked_in).toBe("true");
    });

    test("updates checked_in back to false", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      const attendee = await createTestAttendee(event.id, event.slug, "Check User", "check@example.com");

      await updateCheckedIn(attendee.id, true);
      await updateCheckedIn(attendee.id, false);

      const privateKey = await getTestPrivateKey();
      const rows = await getAttendeesRaw(event.id);
      const decrypted = await decryptAttendees(rows, privateKey);
      expect(decrypted[0]?.checked_in).toBe("false");
    });
  });

  describe("decryptAttendees with empty checked_in", () => {
    test("treats empty checked_in as false for pre-migration attendees", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      await createTestAttendee(event.id, event.slug, "Old User", "old@example.com");

      // Simulate pre-migration state: set checked_in to empty string directly
      await getDb().execute({
        sql: "UPDATE attendees SET checked_in = '' WHERE event_id = ?",
        args: [event.id],
      });

      const privateKey = await getTestPrivateKey();
      const rows = await getAttendeesRaw(event.id);
      expect(rows[0]?.checked_in).toBe("");

      const decrypted = await decryptAttendees(rows, privateKey);
      expect(decrypted[0]?.checked_in).toBe("false");
    });
  });

  describe("initDb checked_in backfill", () => {
    test("backfills empty checked_in with encrypted false during migration", async () => {
      // Create an attendee, then simulate pre-migration state
      const event = await createTestEvent({ maxAttendees: 100 });
      await createTestAttendee(event.id, event.slug, "Backfill User", "backfill@example.com");

      // Set checked_in to empty string to simulate pre-migration data
      await getDb().execute({
        sql: "UPDATE attendees SET checked_in = '' WHERE event_id = ?",
        args: [event.id],
      });

      // Clear the version marker so initDb re-runs migrations
      await getDb().execute(
        "DELETE FROM settings WHERE key = 'latest_db_update'",
      );

      // Re-run migrations - should backfill checked_in
      await initDb();

      // Verify the backfill encrypted the value (no longer empty)
      const rows = await getAttendeesRaw(event.id);
      expect(rows[0]?.checked_in).not.toBe("");

      // Verify it decrypts to "false"
      const privateKey = await getTestPrivateKey();
      const decrypted = await decryptAttendees(rows, privateKey);
      expect(decrypted[0]?.checked_in).toBe("false");
    });
  });

  describe("initDb ticket_token backfill", () => {
    test("backfills empty ticket_token with random tokens during migration", async () => {
      const event = await createTestEvent({ maxAttendees: 100 });
      await createTestAttendee(event.id, event.slug, "Token User", "token@example.com");

      // Set ticket_token to empty string to simulate pre-migration data
      await getDb().execute({
        sql: "UPDATE attendees SET ticket_token = '' WHERE event_id = ?",
        args: [event.id],
      });

      // Clear the version marker so initDb re-runs migrations
      await getDb().execute(
        "DELETE FROM settings WHERE key = 'latest_db_update'",
      );

      // Re-run migrations - should backfill ticket_token
      await initDb();

      // Verify the backfill populated a non-empty token
      const rows = await getAttendeesRaw(event.id);
      expect(rows[0]?.ticket_token).not.toBe("");
      expect(rows[0]?.ticket_token.length).toBeGreaterThan(0);
    });
  });

  describe("writeClosesAt", () => {
    test("encrypts empty string for no deadline", async () => {
      const { decrypt } = await import("#lib/crypto.ts");
      const result = await writeClosesAt("");
      expect(typeof result).toBe("string");
      expect(result).not.toBe("");
      const decrypted = await decrypt(result as unknown as string);
      expect(decrypted).toBe("");
    });

    test("encrypts null as empty string", async () => {
      const { decrypt } = await import("#lib/crypto.ts");
      const result = await writeClosesAt(null);
      const decrypted = await decrypt(result as unknown as string);
      expect(decrypted).toBe("");
    });

    test("normalizes datetime-local format to full ISO", async () => {
      const { decrypt } = await import("#lib/crypto.ts");
      const result = await writeClosesAt("2099-06-15T14:30");
      const decrypted = await decrypt(result as unknown as string);
      expect(decrypted).toBe("2099-06-15T14:30:00.000Z");
    });

    test("handles already-normalized ISO string", async () => {
      const { decrypt } = await import("#lib/crypto.ts");
      const result = await writeClosesAt("2099-06-15T14:30:00.000Z");
      const decrypted = await decrypt(result as unknown as string);
      expect(decrypted).toBe("2099-06-15T14:30:00.000Z");
    });

    test("throws on invalid datetime string", async () => {
      await expect(writeClosesAt("not-a-date")).rejects.toThrow("Invalid closes_at");
    });
  });

  describe("closes_at read transform", () => {
    test("returns null for no-deadline event", async () => {
      const event = await eventsTable.insert({
        name: "test", slug: "test-read-1",
        slugIndex: await computeSlugIndex("test-read-1"),
        maxAttendees: 100, closesAt: "",
      });
      const saved = await getEventWithCount(event.id);
      expect(saved?.closes_at).toBeNull();
    });

    test("returns normalized ISO string for valid datetime", async () => {
      const event = await eventsTable.insert({
        name: "test", slug: "test-read-2",
        slugIndex: await computeSlugIndex("test-read-2"),
        maxAttendees: 100, closesAt: "2099-12-31T23:59",
      });
      const saved = await getEventWithCount(event.id);
      expect(saved?.closes_at).toBe("2099-12-31T23:59:00.000Z");
    });


  });

  describe("closes_at migration backfill", () => {
    test("backfills NULL closes_at to encrypted empty string", async () => {
      const slugIdx = await computeSlugIndex("test-mig-1");
      await getDb().execute({
        sql: `INSERT INTO events (name, slug, slug_index, max_attendees, created, closes_at) VALUES (?, ?, ?, ?, ?, NULL)`,
        args: ["raw-name", "raw-slug", slugIdx, 100, new Date().toISOString()],
      });

      // Update the version marker to force re-migration
      await getDb().execute(
        "UPDATE settings SET value = 'outdated' WHERE key = 'latest_db_update'",
      );
      await initDb();

      // Verify the event now has encrypted closes_at (not NULL)
      const rows = await getDb().execute(
        `SELECT closes_at FROM events WHERE slug_index = ?`,
        [slugIdx],
      );
      const raw = rows.rows[0]?.closes_at as string | null;
      expect(raw).not.toBeNull();
      // Verify it decrypts to empty string (no deadline)
      const { decrypt } = await import("#lib/crypto.ts");
      const decrypted = await decrypt(raw as string);
      expect(decrypted).toBe("");
    });

    test("leaves already-encrypted closes_at values unchanged", async () => {
      const { encrypt, decrypt } = await import("#lib/crypto.ts");
      const encrypted = await encrypt("2099-06-15T14:30:00.000Z");
      const slugIdx = await computeSlugIndex("test-mig-2");
      await getDb().execute({
        sql: `INSERT INTO events (name, slug, slug_index, max_attendees, created, closes_at) VALUES (?, ?, ?, ?, ?, ?)`,
        args: ["enc-name", "enc-slug", slugIdx, 100, new Date().toISOString(), encrypted],
      });

      await getDb().execute(
        "UPDATE settings SET value = 'outdated' WHERE key = 'latest_db_update'",
      );
      await initDb();

      // Verify it still decrypts correctly (not double-encrypted)
      const rows = await getDb().execute(
        `SELECT closes_at FROM events WHERE slug_index = ?`,
        [slugIdx],
      );
      const raw = rows.rows[0]?.closes_at as string | null;
      const decrypted = await decrypt(raw as string);
      expect(decrypted).toBe("2099-06-15T14:30:00.000Z");
    });
  });

  describe("multi-user admin migration", () => {
    test("migrates existing admin_password from settings to users table", async () => {
      const { hashPassword, decrypt } = await import("#lib/crypto.ts");

      // Simulate pre-migration state: admin credentials in settings, no users
      const passwordHash = await hashPassword("existingpassword");
      await setSetting("admin_password", passwordHash);
      await setSetting("wrapped_data_key", "test-wrapped-key");
      await getDb().execute("DELETE FROM users");

      // Force re-migration
      await getDb().execute(
        "UPDATE settings SET value = 'outdated' WHERE key = 'latest_db_update'",
      );
      await initDb();

      // Verify an owner user was created
      const rows = await getDb().execute("SELECT * FROM users");
      expect(rows.rows.length).toBe(1);

      const user = rows.rows[0] as unknown as { password_hash: string; wrapped_data_key: string; admin_level: string };
      const decryptedLevel = await decrypt(user.admin_level);
      expect(decryptedLevel).toBe("owner");
      expect(user.wrapped_data_key).toBe("test-wrapped-key");

      // Verify the password hash was encrypted (not stored raw)
      const decryptedHash = await decrypt(user.password_hash);
      expect(decryptedHash).toBe(passwordHash);
    });

    test("skips migration when users already exist", async () => {
      // createTestDbWithSetup already created a user
      await setSetting("admin_password", "old-hash");
      await setSetting("wrapped_data_key", "old-key");

      const beforeCount = await getDb().execute("SELECT COUNT(*) as count FROM users");
      const countBefore = (beforeCount.rows[0] as unknown as { count: number }).count;

      // Force re-migration
      await getDb().execute(
        "UPDATE settings SET value = 'outdated' WHERE key = 'latest_db_update'",
      );
      await initDb();

      // Verify no additional user was created
      const afterCount = await getDb().execute("SELECT COUNT(*) as count FROM users");
      expect((afterCount.rows[0] as unknown as { count: number }).count).toBe(countBefore);
    });

    test("skips migration when no admin_password in settings", async () => {
      // Remove all users and ensure no admin_password setting exists
      await getDb().execute("DELETE FROM users");

      // Force re-migration
      await getDb().execute(
        "UPDATE settings SET value = 'outdated' WHERE key = 'latest_db_update'",
      );
      await initDb();

      // Verify no user was created
      const rows = await getDb().execute("SELECT COUNT(*) as count FROM users");
      expect((rows.rows[0] as unknown as { count: number }).count).toBe(0);
    });
  });
});
