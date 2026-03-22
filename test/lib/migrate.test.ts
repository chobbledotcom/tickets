import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  decryptWithKey,
  deriveKEK,
  importPrivateKey,
  unwrapKey,
} from "#lib/crypto.ts";
import {
  decryptAttendees,
  getAttendeesRaw,
  getMigrationProgress,
  MIGRATE_BATCH_SIZE,
  markRefunded,
  migrateAttendeeBatch,
  updateCheckedIn,
} from "#lib/db/attendees.ts";
import { getDb } from "#lib/db/client.ts";
import {
  getWrappedPrivateKey,
  isAttendeeBlobMigrated,
  setAttendeeBlobMigrated,
} from "#lib/db/settings.ts";
import { getUserByUsername, verifyUserPassword } from "#lib/db/users.ts";
import {
  adminFormPost,
  adminGet,
  createPaidTestAttendee,
  createTestAttendee,
  createTestEvent,
  describeWithEnv,
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
} from "#test-utils";

/** Helper to get private key for decrypting attendees in tests */
const getTestPrivateKey = async (): Promise<CryptoKey> => {
  const user = await getUserByUsername(TEST_ADMIN_USERNAME);
  if (!user) throw new Error("Test setup failed: user not found");
  const passwordHash = await verifyUserPassword(user, TEST_ADMIN_PASSWORD);
  if (!passwordHash) throw new Error("Test setup failed: invalid password");
  if (!user.wrapped_data_key)
    throw new Error("Test setup failed: no wrapped data key");
  const kek = await deriveKEK(passwordHash);
  const dataKey = await unwrapKey(user.wrapped_data_key, kek);
  const wrappedPrivateKey = await getWrappedPrivateKey();
  if (!wrappedPrivateKey)
    throw new Error("Test setup failed: no wrapped private key");
  const privateKeyJwk = await decryptWithKey(wrappedPrivateKey, dataKey);
  return importPrivateKey(privateKeyJwk);
};

describeWithEnv("attendee blob migration", { db: true }, () => {
  describe("isAttendeeBlobMigrated", () => {
    test("returns false when setting is empty", async () => {
      expect(await isAttendeeBlobMigrated()).toBe(false);
    });

    test("returns true after setAttendeeBlobMigrated", async () => {
      await setAttendeeBlobMigrated();
      expect(await isAttendeeBlobMigrated()).toBe(true);
    });
  });

  describe("getMigrationProgress", () => {
    test("returns zero counts with no attendees", async () => {
      const progress = await getMigrationProgress();
      expect(progress).toEqual({ total: 0, remaining: 0 });
    });

    test("counts unmigrated attendees", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      await createTestAttendee(event.id, event.slug, "Alice", "a@test.com");
      await createTestAttendee(event.id, event.slug, "Bob", "b@test.com");

      const progress = await getMigrationProgress();
      // New attendees created with pii_blob populated, so remaining should be 0
      // because createAttendeeAtomic now writes pii_blob
      expect(progress.total).toBe(2);
      expect(progress.remaining).toBe(0);
    });

    test("counts attendees with empty pii_blob as unmigrated", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      await createTestAttendee(event.id, event.slug, "Alice", "a@test.com");
      // Simulate pre-migration state by clearing pii_blob
      await getDb().execute("UPDATE attendees SET pii_blob = ''");

      const progress = await getMigrationProgress();
      expect(progress.total).toBe(1);
      expect(progress.remaining).toBe(1);
    });
  });

  describe("migrateAttendeeBatch", () => {
    test("migrates attendees from per-field to blob encryption", async () => {
      const event = await createTestEvent({
        maxAttendees: 10,
        unitPrice: 500,
      });
      await createPaidTestAttendee(
        event.id,
        "Alice Smith",
        "alice@test.com",
        "pi_123",
        1500,
      );

      // Simulate pre-migration: clear pii_blob and v2 columns
      await getDb().execute(
        "UPDATE attendees SET pii_blob = '', checked_in_v2 = 0, refunded_v2 = 0, price_paid_v2 = 0",
      );

      const privateKey = await getTestPrivateKey();
      const result = await migrateAttendeeBatch(privateKey);

      expect(result.migrated).toBe(1);
      expect(result.remaining).toBe(0);

      // Verify the new columns are populated
      const rows = await getAttendeesRaw(event.id);
      expect(rows[0]!.pii_blob).not.toBe("");
      expect(rows[0]!.price_paid_v2).toBe(1500);
      expect(rows[0]!.checked_in_v2).toBe(0);
      expect(rows[0]!.refunded_v2).toBe(0);
    });

    test("preserves checked_in and refunded status during migration", async () => {
      const event = await createTestEvent({
        maxAttendees: 10,
        unitPrice: 500,
      });
      const attendee = await createPaidTestAttendee(
        event.id,
        "Bob",
        "bob@test.com",
        "pi_456",
        2000,
      );

      // Check in and refund
      await updateCheckedIn(attendee.id, true);
      await markRefunded(attendee.id);

      // Simulate pre-migration: clear blob + v2 columns
      await getDb().execute(
        "UPDATE attendees SET pii_blob = '', checked_in_v2 = 0, refunded_v2 = 0, price_paid_v2 = 0",
      );

      const privateKey = await getTestPrivateKey();
      await migrateAttendeeBatch(privateKey);

      const rows = await getAttendeesRaw(event.id);
      expect(rows[0]!.checked_in_v2).toBe(1);
      expect(rows[0]!.refunded_v2).toBe(1);
      expect(rows[0]!.price_paid_v2).toBe(2000);
    });

    test("decrypts correctly from blob after migration", async () => {
      const event = await createTestEvent({
        maxAttendees: 10,
        unitPrice: 500,
      });
      await createPaidTestAttendee(
        event.id,
        "Charlie",
        "charlie@test.com",
        "pi_789",
        3000,
      );

      // Simulate pre-migration and migrate
      await getDb().execute(
        "UPDATE attendees SET pii_blob = '', checked_in_v2 = 0, refunded_v2 = 0, price_paid_v2 = 0",
      );
      const privateKey = await getTestPrivateKey();
      await migrateAttendeeBatch(privateKey);

      // Now decrypt using the blob path
      const rows = await getAttendeesRaw(event.id);
      const decrypted = await decryptAttendees(rows, privateKey);

      expect(decrypted[0]!.name).toBe("Charlie");
      expect(decrypted[0]!.email).toBe("charlie@test.com");
      expect(decrypted[0]!.payment_id).toBe("pi_789");
      expect(decrypted[0]!.price_paid).toBe("3000");
      expect(decrypted[0]!.checked_in).toBe(false);
      expect(decrypted[0]!.refunded).toBe(false);
    });

    test("returns zero migrated when all attendees already migrated", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      await createTestAttendee(event.id, event.slug, "Done", "done@test.com");

      const privateKey = await getTestPrivateKey();
      const result = await migrateAttendeeBatch(privateKey);

      expect(result.migrated).toBe(0);
      expect(result.remaining).toBe(0);
    });

    test("processes only MIGRATE_BATCH_SIZE attendees per call", () => {
      expect(MIGRATE_BATCH_SIZE).toBe(100);
    });
  });

  describe("new attendees write pii_blob", () => {
    test("createAttendeeAtomic populates pii_blob", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      await createTestAttendee(
        event.id,
        event.slug,
        "New User",
        "new@test.com",
      );

      const rows = await getAttendeesRaw(event.id);
      expect(rows[0]!.pii_blob).not.toBe("");
    });

    test("createAttendeeAtomic sets v2 integer columns", async () => {
      const event = await createTestEvent({
        maxAttendees: 10,
        unitPrice: 1000,
      });
      await createPaidTestAttendee(
        event.id,
        "Paid User",
        "paid@test.com",
        "pi_new",
        2500,
      );

      const rows = await getAttendeesRaw(event.id);
      expect(rows[0]!.price_paid_v2).toBe(2500);
      expect(rows[0]!.checked_in_v2).toBe(0);
      expect(rows[0]!.refunded_v2).toBe(0);
    });
  });

  describe("updateCheckedIn writes v2 column", () => {
    test("sets checked_in_v2 to 1 when checking in", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Check",
        "check@test.com",
      );

      await updateCheckedIn(attendee.id, true);

      const rows = await getAttendeesRaw(event.id);
      expect(rows[0]!.checked_in_v2).toBe(1);
    });

    test("sets checked_in_v2 back to 0 when unchecking", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      const attendee = await createTestAttendee(
        event.id,
        event.slug,
        "Uncheck",
        "uncheck@test.com",
      );

      await updateCheckedIn(attendee.id, true);
      await updateCheckedIn(attendee.id, false);

      const rows = await getAttendeesRaw(event.id);
      expect(rows[0]!.checked_in_v2).toBe(0);
    });
  });

  describe("markRefunded writes v2 column", () => {
    test("sets refunded_v2 to 1", async () => {
      const event = await createTestEvent({
        maxAttendees: 10,
        unitPrice: 500,
      });
      const attendee = await createPaidTestAttendee(
        event.id,
        "Refund",
        "refund@test.com",
        "pi_ref",
        500,
      );

      await markRefunded(attendee.id);

      const rows = await getAttendeesRaw(event.id);
      expect(rows[0]!.refunded_v2).toBe(1);
    });
  });

  describe("GET /admin/migrate", () => {
    test("shows migration page when not migrated", async () => {
      const { response } = await adminGet("/admin/migrate");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Database Migration");
      expect(html).toContain("Process next batch");
    });

    test("shows completion message when already migrated", async () => {
      await setAttendeeBlobMigrated();
      const { response } = await adminGet("/admin/migrate");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Migration complete");
    });
  });

  describe("POST /admin/migrate", () => {
    test("processes a batch and returns progress", async () => {
      const event = await createTestEvent({ maxAttendees: 10 });
      await createTestAttendee(event.id, event.slug, "Mig", "mig@test.com");
      // Simulate pre-migration
      await getDb().execute(
        "UPDATE attendees SET pii_blob = '', checked_in_v2 = 0, refunded_v2 = 0, price_paid_v2 = 0",
      );

      const { response } = await adminFormPost("/admin/migrate");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.migrated).toBe(1);
      expect(body.remaining).toBe(0);
      expect(body.done).toBe(true);
    });

    test("returns done when already migrated", async () => {
      await setAttendeeBlobMigrated();
      const { response } = await adminFormPost("/admin/migrate");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.done).toBe(true);
    });
  });

  describe("dashboard migration banner", () => {
    test("shows migration banner when not migrated", async () => {
      const { response } = await adminGet("/admin/");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Run migration");
      expect(html).toContain("/admin/migrate");
    });

    test("hides migration banner after migration", async () => {
      await setAttendeeBlobMigrated();
      const { response } = await adminGet("/admin/");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("Run migration");
    });
  });
});
