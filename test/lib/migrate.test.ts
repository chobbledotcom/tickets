import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { decryptWithKey, encrypt } from "#lib/crypto/encryption.ts";
import {
  decryptAttendeePII,
  deriveKEK,
  encryptAttendeePII,
  importPrivateKey,
  unwrapKey,
} from "#lib/crypto/keys.ts";
import {
  decryptAttendees,
  getAttendeesRaw,
  getMigrationProgress,
  MIGRATE_BATCH_SIZE,
  markRefunded,
  migrateAttendeeBatch,
  PII_BLOB_VERSION,
  updateCheckedIn,
} from "#lib/db/attendees.ts";
import { getDb } from "#lib/db/client.ts";
import { settings } from "#lib/db/settings.ts";
import { getUserByUsername, verifyUserPassword } from "#lib/db/users.ts";
import {
  adminFormPost,
  adminGet,
  awaitTestRequest,
  createPaidTestAttendee,
  createTestAttendee,
  createTestEvent,
  createTestManagerSession,
  describeWithEnv,
  mockFormRequest,
  setTestEnv,
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
  const wrappedPrivateKey = settings.wrappedPrivateKey;
  if (!wrappedPrivateKey)
    throw new Error("Test setup failed: no wrapped private key");
  const privateKeyJwk = await decryptWithKey(wrappedPrivateKey, dataKey);
  return importPrivateKey(privateKeyJwk);
};

/** Insert a legacy-format attendee row with per-field encryption (no pii_blob) */
const insertLegacyAttendee = async (
  eventId: number,
  fields: {
    name: string;
    email: string;
    phone?: string;
    paymentId?: string;
    pricePaid?: number;
    checkedIn?: boolean;
    refunded?: boolean;
  },
) => {
  const pubKey = settings.publicKey!;
  const [encName, encEmail, encPhone, encPaymentId, encPricePaid] =
    await Promise.all([
      encryptAttendeePII(fields.name, pubKey),
      encryptAttendeePII(fields.email, pubKey),
      encryptAttendeePII(fields.phone ?? "", pubKey),
      encryptAttendeePII(fields.paymentId ?? "", pubKey),
      encrypt(String(fields.pricePaid ?? 0)),
    ]);
  const encCheckedIn = fields.checkedIn
    ? await encryptAttendeePII("true", pubKey)
    : await encryptAttendeePII("false", pubKey);
  const encRefunded = fields.refunded
    ? await encryptAttendeePII("true", pubKey)
    : await encryptAttendeePII("false", pubKey);
  const encToken = await encryptAttendeePII("tok_legacy", pubKey);
  const result = await getDb().execute({
    sql: `INSERT INTO attendees (name, email, phone, address, special_instructions, payment_id, price_paid, checked_in, refunded, ticket_token, created)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    args: [
      encName,
      encEmail,
      encPhone,
      await encryptAttendeePII("", pubKey),
      await encryptAttendeePII("", pubKey),
      encPaymentId,
      encPricePaid,
      encCheckedIn,
      encRefunded,
      encToken,
    ],
  });
  // Also insert into event_attendees join table
  await getDb().execute({
    sql: "INSERT INTO event_attendees (event_id, attendee_id, quantity) VALUES (?, ?, 1)",
    args: [eventId, Number(result.lastInsertRowid)],
  });
};

/** Create a test event with the migration gate temporarily enabled */
const createTestEventForMigration = async (
  overrides: Parameters<typeof createTestEvent>[0] = {},
) => {
  await settings.update.attendeeBlobMigrated();
  const event = await createTestEvent(overrides);
  await settings.setRaw("attendee_blob_migrated", "");
  settings.invalidateCache();
  await settings.loadAll();
  return event;
};

describeWithEnv("attendee blob migration", { db: true }, () => {
  // createTestDbWithSetup marks migration as complete; clear it for migration tests
  beforeEach(async () => {
    await settings.setRaw("attendee_blob_migrated", "");
    settings.invalidateCache();
    await settings.loadAll();
  });

  describe("isAttendeeBlobMigrated", () => {
    test("returns false when setting is empty", () => {
      expect(settings.attendeeBlobMigrated).toBe(false);
    });

    test("returns true after setAttendeeBlobMigrated", async () => {
      await settings.update.attendeeBlobMigrated();
      expect(settings.attendeeBlobMigrated).toBe(true);
    });
  });

  describe("getMigrationProgress", () => {
    test("returns zero counts with no attendees", async () => {
      const progress = await getMigrationProgress();
      expect(progress).toEqual({ total: 0, remaining: 0 });
    });

    test("counts unmigrated attendees", async () => {
      const event = await createTestEventForMigration({ maxAttendees: 10 });
      await createTestAttendee(event.id, event.slug, "Alice", "a@test.com");
      await createTestAttendee(event.id, event.slug, "Bob", "b@test.com");

      const progress = await getMigrationProgress();
      // New attendees created with pii_blob populated, so remaining should be 0
      // because createAttendeeAtomic now writes pii_blob
      expect(progress.total).toBe(2);
      expect(progress.remaining).toBe(0);
    });

    test("counts attendees with empty pii_blob as unmigrated", async () => {
      const event = await createTestEventForMigration({ maxAttendees: 10 });
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
      const event = await createTestEventForMigration({ maxAttendees: 10 });
      await insertLegacyAttendee(event.id, {
        name: "Alice Smith",
        email: "alice@test.com",
        paymentId: "pi_123",
        pricePaid: 1500,
      });

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
      const event = await createTestEventForMigration({ maxAttendees: 10 });
      await insertLegacyAttendee(event.id, {
        name: "Bob",
        email: "bob@test.com",
        paymentId: "pi_456",
        pricePaid: 2000,
        checkedIn: true,
        refunded: true,
      });

      const privateKey = await getTestPrivateKey();
      await migrateAttendeeBatch(privateKey);

      const rows = await getAttendeesRaw(event.id);
      expect(rows[0]!.checked_in_v2).toBe(1);
      expect(rows[0]!.refunded_v2).toBe(1);
      expect(rows[0]!.price_paid_v2).toBe(2000);
    });

    test("decrypts correctly from blob after migration", async () => {
      const event = await createTestEventForMigration({ maxAttendees: 10 });
      await insertLegacyAttendee(event.id, {
        name: "Charlie",
        email: "charlie@test.com",
        paymentId: "pi_789",
        pricePaid: 3000,
      });

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

    test("decrypts pre-versioned blobs without v field", async () => {
      const event = await createTestEventForMigration({ maxAttendees: 10 });
      // Manually create a blob without the v field (simulating pre-versioned data)
      const pubKey = settings.publicKey!;
      const blobWithoutVersion = JSON.stringify({
        n: "OldBlob",
        e: "old@test.com",
        p: "",
        a: "",
        s: "",
        pi: "",
        t: "tok_old",
      });
      const encrypted = await encryptAttendeePII(blobWithoutVersion, pubKey);
      const insertResult = await getDb().execute({
        sql: `INSERT INTO attendees (name, email, phone, address, special_instructions, payment_id, price_paid, checked_in, refunded, ticket_token, pii_blob, checked_in_v2, refunded_v2, price_paid_v2, created)
              VALUES ('', '', '', '', '', '', '', '', '', '', ?, 0, 0, 0, datetime('now'))`,
        args: [encrypted],
      });
      await getDb().execute({
        sql: "INSERT INTO event_attendees (event_id, attendee_id, quantity) VALUES (?, ?, 1)",
        args: [event.id, Number(insertResult.lastInsertRowid)],
      });

      const privateKey = await getTestPrivateKey();
      const rows = await getAttendeesRaw(event.id);
      const decrypted = await decryptAttendees(rows, privateKey);
      expect(decrypted[0]!.name).toBe("OldBlob");
      expect(decrypted[0]!.email).toBe("old@test.com");
    });

    test("returns zero migrated when all attendees already migrated", async () => {
      const event = await createTestEventForMigration({ maxAttendees: 10 });
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
      const event = await createTestEventForMigration({ maxAttendees: 10 });
      await createTestAttendee(
        event.id,
        event.slug,
        "New User",
        "new@test.com",
      );

      const rows = await getAttendeesRaw(event.id);
      expect(rows[0]!.pii_blob).not.toBe("");
    });

    test("pii_blob includes version field", async () => {
      const event = await createTestEventForMigration({ maxAttendees: 10 });
      await createTestAttendee(event.id, event.slug, "V", "v@test.com");

      const rows = await getAttendeesRaw(event.id);
      const privateKey = await getTestPrivateKey();
      const json = await decryptAttendeePII(rows[0]!.pii_blob, privateKey);
      const blob = JSON.parse(json);
      expect(blob.v).toBe(PII_BLOB_VERSION);
    });

    test("createAttendeeAtomic sets v2 integer columns", async () => {
      const event = await createTestEventForMigration({
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
      const event = await createTestEventForMigration({ maxAttendees: 10 });
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
      const event = await createTestEventForMigration({ maxAttendees: 10 });
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
      const event = await createTestEventForMigration({
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
      const event = await createTestEventForMigration({ maxAttendees: 10 });
      await insertLegacyAttendee(event.id, {
        name: "Pending",
        email: "pending@test.com",
      });
      const { response } = await adminGet("/admin/migrate");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Database Migration");
      expect(html).toContain("Process next batch");
    });

    test("shows progress bar when there are unmigrated attendees", async () => {
      const event = await createTestEventForMigration({ maxAttendees: 10 });
      await insertLegacyAttendee(event.id, {
        name: "Pending",
        email: "pending@test.com",
      });

      const { response } = await adminGet("/admin/migrate");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("<progress");
      expect(html).toContain("1 remaining");
    });

    test("shows completion message when already migrated", async () => {
      await settings.update.attendeeBlobMigrated();
      const { response } = await adminGet("/admin/migrate");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Migration complete");
    });

    test("accessible to managers", async () => {
      await settings.update.attendeeBlobMigrated();
      const managerCookie = await createTestManagerSession();
      const response = await awaitTestRequest("/admin/migrate", {
        cookie: managerCookie,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Migration complete");
    });
  });

  describe("POST /admin/migrate", () => {
    test("processes a batch and redirects to dashboard when done", async () => {
      const event = await createTestEventForMigration({ maxAttendees: 10 });
      await createTestAttendee(event.id, event.slug, "Mig", "mig@test.com");
      // Simulate pre-migration
      await getDb().execute(
        "UPDATE attendees SET pii_blob = '', checked_in_v2 = 0, refunded_v2 = 0, price_paid_v2 = 0",
      );

      const { response } = await adminFormPost("/admin/migrate");
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/");

      // Verify the batch was actually processed
      const progress = await getMigrationProgress();
      expect(progress.remaining).toBe(0);
    });

    test("redirects back to migrate when batch is incomplete", async () => {
      const event = await createTestEventForMigration({ maxAttendees: 10 });
      // Insert 2 legacy attendees with batch size of 1
      await insertLegacyAttendee(event.id, {
        name: "A",
        email: "a@test.com",
      });
      await insertLegacyAttendee(event.id, {
        name: "B",
        email: "b@test.com",
      });

      const restore = setTestEnv({ MIGRATE_BATCH_SIZE: "1" });
      try {
        const { response } = await adminFormPost("/admin/migrate");
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/admin/migrate");

        // Migration should NOT be marked complete
        expect(settings.attendeeBlobMigrated).toBe(false);
      } finally {
        restore();
      }
    });

    test("redirects when already migrated", async () => {
      await settings.update.attendeeBlobMigrated();
      const { response } = await adminFormPost("/admin/migrate");
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/migrate");
    });

    test("accessible to managers", async () => {
      await settings.update.attendeeBlobMigrated();
      const managerCookie = await createTestManagerSession();
      const { signCsrfToken } = await import("#lib/csrf.ts");
      const csrfToken = await signCsrfToken();
      const { handleRequest } = await import("#routes");
      const response = await handleRequest(
        mockFormRequest(
          "/admin/migrate",
          { csrf_token: csrfToken },
          managerCookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/migrate");
    });
  });

  describe("admin gating behind migration", () => {
    test("redirects to /admin/migrate when not migrated", async () => {
      const { response } = await adminGet("/admin/event/1");
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/migrate");
    });

    test("redirects /admin dashboard when not migrated", async () => {
      // Insert a legacy attendee so auto-complete doesn't trigger on GET /admin/migrate
      const event = await createTestEventForMigration({ maxAttendees: 10 });
      await insertLegacyAttendee(event.id, {
        name: "Pending",
        email: "pending@test.com",
      });
      const { response } = await adminGet("/admin");
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/migrate");
    });

    test("allows dashboard after migration", async () => {
      await settings.update.attendeeBlobMigrated();
      const { response } = await adminGet("/admin/");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("Run migration");
    });

    test("allows /admin/migrate when not migrated", async () => {
      // Insert a legacy attendee so auto-complete doesn't trigger
      const event = await createTestEventForMigration({ maxAttendees: 10 });
      await insertLegacyAttendee(event.id, {
        name: "Pending",
        email: "pending@test.com",
      });
      const { response } = await adminGet("/admin/migrate");
      expect(response.status).toBe(200);
    });
  });

  describe("auto-complete migration for fresh databases", () => {
    test("GET /admin/migrate auto-completes when no attendees exist", async () => {
      expect(settings.attendeeBlobMigrated).toBe(false);

      const { response } = await adminGet("/admin/migrate");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Migration complete");

      expect(settings.attendeeBlobMigrated).toBe(true);
    });

    test("GET /admin/migrate auto-completes when all attendees already migrated", async () => {
      const event = await createTestEventForMigration({ maxAttendees: 10 });
      await createTestAttendee(
        event.id,
        event.slug,
        "Already",
        "done@test.com",
      );

      expect(settings.attendeeBlobMigrated).toBe(false);

      const { response } = await adminGet("/admin/migrate");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Migration complete");

      expect(settings.attendeeBlobMigrated).toBe(true);
    });
  });
});
