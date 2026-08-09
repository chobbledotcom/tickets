import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  createMigrationVerifyOwnerKey,
  createMigrationVerifyReader,
} from "#scripts/migration-verify-deps.ts";
import { runMigrationVerifyCli } from "#scripts/migration-verify-lib.ts";
import { encrypt as envEncrypt } from "#shared/crypto/encryption.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { encryptWithOwnerKey } from "#shared/crypto/keys.ts";
import { buildPiiBlob, encryptPiiBlob } from "#shared/db/attendees/pii.ts";
import { execute, queryOne } from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import { invalidateUsersCache } from "#shared/db/users.ts";
import { nowIso } from "#shared/now.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import { createTestDbWithSetup, resetDb } from "#test-utils/db.ts";
import {
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
} from "#test-utils/internal.ts";

const DEFAULT_PAGE_SIZE = 2;

interface Clip {
  args: string[];
  errors: string[];
  output: string[];
  promptResponse: string | null;
}

const clip = (args: string[], promptResponse: string | null = null): Clip => ({
  args,
  errors: [],
  output: [],
  promptResponse,
});

const run = (clip: Clip, pageSize = DEFAULT_PAGE_SIZE) =>
  runMigrationVerifyCli({
    args: clip.args,
    createReader: () => createMigrationVerifyReader(pageSize),
    getEnv: () => undefined,
    ownerKey: createMigrationVerifyOwnerKey(),
    pageSize,
    prompt: () => clip.promptResponse,
    stderr: (line) => clip.errors.push(line),
    stdout: (line) => clip.output.push(line),
  });

/** Run with the test owner credentials and return the clip + result so each
 *  test asserts on the same possessor without restating the run boilerplate. */
const runOwner = async (
  args: string[] = ["--owner", TEST_ADMIN_USERNAME],
  password: string | null = TEST_ADMIN_PASSWORD,
): Promise<{ result: number; out: string; errors: string }> => {
  const c = clip(args, password);
  const result = await run(c);
  return { errors: c.errors.join("\n"), out: c.output.join("\n"), result };
};

const seedAttendee = async (pii = true): Promise<number> => {
  const blob = pii
    ? await encryptPiiBlob(
        buildPiiBlob({
          address: "1 Road",
          email: "buyer@example.com",
          lat: "",
          lng: "",
          name: "Buyer",
          payment_id: "pi_123",
          phone: "+44",
          special_instructions: "",
          ticket_token: "tt",
        }),
        settings.publicKey,
      )
    : "";
  await execute(
    "INSERT INTO attendees (created, kind, pii_blob) VALUES (?, 'attendee', ?)",
    [nowIso(), blob],
  );
  const rows = await execute(
    "SELECT id FROM attendees ORDER BY id DESC LIMIT 1",
  );
  return Number(rows.rows[0]![0]);
};

const seedProcessed = async (
  sessionId: string,
  attendeeId: number,
): Promise<void> => {
  await execute(
    `INSERT INTO processed_payments (payment_session_id, attendee_id, processed_at, payment_reference, provider_refunded_at)
     VALUES (?, ?, ?, '', '')`,
    [sessionId, attendeeId, "2026-01-01T00:00:00.000Z"],
  );
};

const seedStage = async (
  sessionId: string,
  attendeeId: number,
): Promise<void> => {
  await execute(
    `INSERT INTO checkout_stages (payment_session_id, attendee_id, provider, ticket_tokens, state, created_at)
     VALUES (?, ?, 'stripe', '', 'completed', ?)`,
    [sessionId, attendeeId, "2026-01-01T00:00:00.000Z"],
  );
};

const seedConsistentPayment = async (
  sessionId: string,
  attendeeId: number,
): Promise<void> => {
  await seedProcessed(sessionId, attendeeId);
  await seedStage(sessionId, attendeeId);
};

/** Assert the run refused to derive the owner key: exit 1, a "could not be
 *  derived" stderr message, and an "owner key not supplied" report line. Shared
 *  by the wrong-password, unknown-username, absent-private-key, and non-owner
 *  cases so their assertion blocks differ only in setup. */
const expectOwnerKeyBlocked = (c: Clip, result: number): void => {
  expect(result).toBe(1);
  expect(c.errors.join("\n")).toContain("could not be derived");
  expect(c.output.join("\n")).toContain("owner key not supplied");
};

describe("migration-verify production wiring", () => {
  beforeEach(async () => {
    await createTestDbWithSetup();
    await settings.loadKeys([
      CONFIG_KEYS.PUBLIC_KEY,
      CONFIG_KEYS.WRAPPED_PRIVATE_KEY,
    ]);
  });
  afterEach(() => resetDb());

  test("verifies a consistent database end to end with the owner key", async () => {
    const attendeeId = await seedAttendee();
    // A matching stage for one session, plus five processed-payment rows that
    // cross more than one keyset page (checkout_stages.attendee_id is unique).
    await seedStage("sess-0", attendeeId);
    for (let i = 0; i < 5; i++) await seedProcessed(`sess-${i}`, attendeeId);

    const c = clip(["--owner", TEST_ADMIN_USERNAME], TEST_ADMIN_PASSWORD);
    const result = await run(c);

    expect(result).toBe(0);
    const out = c.output.join("\n");
    expect(out).toContain("Payment migration readiness: ready");
    expect(out).toContain("processed_payments rows: 5");
    expect(out).toContain("checkout_stages rows: 1");
    expect(out).toContain("verified 1 of 1 attendee PII blob");
  });

  test("blocks with the owner-key contradiction when no password is supplied", async () => {
    const attendeeId = await seedAttendee();
    await seedConsistentPayment("sess-1", attendeeId);

    const c = clip(["--owner", TEST_ADMIN_USERNAME], null);
    const result = await run(c);

    expect(result).toBe(1);
    expect(c.output.join("\n")).toContain("owner key not supplied");
  });

  test("blocks when the owner password is wrong", async () => {
    const attendeeId = await seedAttendee();
    await seedConsistentPayment("sess-1", attendeeId);

    const c = clip(["--owner", TEST_ADMIN_USERNAME], "the-wrong-password");
    expectOwnerKeyBlocked(c, await run(c));
  });

  test("blocks when the owner username is unknown", async () => {
    const attendeeId = await seedAttendee();
    await seedConsistentPayment("sess-1", attendeeId);

    const c = clip(["--owner", "nobody"], "anything");
    const result = await run(c);

    expect(result).toBe(1);
    expect(c.errors.join("\n")).toContain("could not be derived");
  });

  test("blocks when the wrapped private key setting is absent", async () => {
    const attendeeId = await seedAttendee();
    await seedConsistentPayment("sess-1", attendeeId);
    await execute("DELETE FROM settings WHERE key = ?", [
      CONFIG_KEYS.WRAPPED_PRIVATE_KEY,
    ]);
    settings.setup.clearCache();
    settings.invalidateCache();
    await settings.loadKeys([CONFIG_KEYS.PUBLIC_KEY]);

    const c = clip(["--owner", TEST_ADMIN_USERNAME], TEST_ADMIN_PASSWORD);
    const result = await run(c);

    expect(result).toBe(1);
    expect(c.errors.join("\n")).toContain("could not be derived");
  });

  test("reports an attendee PII blob that does not decrypt", async () => {
    const attendeeId = await seedAttendee();
    await seedConsistentPayment("sess-1", attendeeId);
    // Corrupt one blob so the owner key cannot decrypt it.
    await execute(
      "UPDATE attendees SET pii_blob = 'hyb:1:corrupt' WHERE id = ?",
      [attendeeId],
    );

    const c = clip(["--owner", TEST_ADMIN_USERNAME], TEST_ADMIN_PASSWORD);
    const result = await run(c);

    expect(result).toBe(1);
    expect(c.output.join("\n")).toContain("attendee PII that did not decrypt");
  });

  test("counts a merge-reference charge that decrypts under the owner key", async () => {
    const target = await seedAttendee();
    const source = await seedAttendee();
    await seedConsistentPayment("sess-1", target);
    const encryptedRef = await encryptWithOwnerKey(
      "pi_charge",
      settings.publicKey,
    );
    await execute(
      `INSERT INTO processed_payments (payment_session_id, attendee_id, processed_at, payment_reference, provider_refunded_at)
       VALUES (?, ?, ?, ?, '')`,
      [
        `legacy-merge:${source}`,
        target,
        "2026-01-01T00:00:00.000Z",
        encryptedRef,
      ],
    );

    const { out, result } = await runOwner();

    expect(result).toBe(0);
    expect(out).toContain("merge references: 1");
  });

  test("does not block a terminal failure row (null attendee + failure_data set)", async () => {
    await seedAttendee();
    await execute(
      `INSERT INTO processed_payments (payment_session_id, attendee_id, processed_at, payment_reference, provider_refunded_at, failure_data)
       VALUES (?, NULL, ?, '', '', ?)`,
      ["failed-session", "2026-01-01T00:00:00.000Z", "enc:1:failure"],
    );

    const { out, result } = await runOwner();

    expect(result).toBe(0);
    expect(out).not.toContain("processed payment without a live attendee");
  });

  test("blocks on an encrypted merge-reference charge when no owner key is supplied", async () => {
    const target = await seedAttendee(false);
    const encryptedRef = await encryptWithOwnerKey(
      "pi_charge",
      settings.publicKey,
    );
    await execute(
      `INSERT INTO processed_payments (payment_session_id, attendee_id, processed_at, payment_reference, provider_refunded_at)
       VALUES (?, ?, ?, ?, '')`,
      ["legacy-merge:99", target, "2026-01-01T00:00:00.000Z", encryptedRef],
    );

    const c = clip([]); // no --owner, no password
    const result = await run(c);

    expect(result).toBe(1);
    expect(c.output.join("\n")).toContain("owner key not supplied");
  });

  test("passes the parsed --page-size to the database reader", async () => {
    const attendeeId = await seedAttendee();
    await seedStage("p-0", attendeeId);
    // Six processed rows, read at --page-size 2 → at least three keyset pages.
    for (let i = 0; i < 6; i++) await seedProcessed(`p-${i}`, attendeeId);

    let seenPageSize = 0;
    const c = clip(["--owner", TEST_ADMIN_USERNAME], TEST_ADMIN_PASSWORD);
    const result = await runMigrationVerifyCli({
      args: c.args,
      createReader: (pageSize) => {
        seenPageSize = pageSize;
        return createMigrationVerifyReader(pageSize);
      },
      getEnv: () => undefined,
      ownerKey: createMigrationVerifyOwnerKey(),
      pageSize: DEFAULT_PAGE_SIZE,
      prompt: () => c.promptResponse,
      stderr: (line) => c.errors.push(line),
      stdout: (line) => c.output.push(line),
    });

    expect(result).toBe(0);
    expect(seenPageSize).toBe(2);
    expect(c.output.join("\n")).toContain("processed_payments rows: 6");
  });

  test("blocks when --owner is a non-owner account carrying the site data key", async () => {
    // Seed an attendee with PII so a refused owner key actually blocks (a null
    // derive with nothing encrypted would otherwise read as ready).
    await seedAttendee();
    // Seed a manager-level user that reuses the owner's password hash and
    // wrapped data key (as invite acceptance would), so the owner password
    // verifies but the admin level is not "owner" — derive must refuse.
    const owner = await queryOne<{
      password_hash: string;
      wrapped_data_key: string;
      kek_version: number;
    }>(
      "SELECT password_hash, wrapped_data_key, kek_version FROM users WHERE username_index = ?",
      [await hmacHash(TEST_ADMIN_USERNAME)],
    );
    await execute(
      `INSERT INTO users
         (username_hash, username_index, password_hash, wrapped_data_key, admin_level, invite_code_hash, invite_expiry, kek_version)
       VALUES (?, ?, ?, ?, ?, '', '', ?)`,
      [
        await envEncrypt("manager"),
        await hmacHash("manager"),
        owner!.password_hash,
        owner!.wrapped_data_key,
        await envEncrypt("manager"),
        owner!.kek_version,
      ],
    );
    invalidateUsersCache();

    const c = clip(["--owner", "manager"], TEST_ADMIN_PASSWORD);
    expectOwnerKeyBlocked(c, await run(c));
  });

  test("blocks on a corrupt regular (non-merge) captured charge reference", async () => {
    const attendeeId = await seedAttendee();
    await seedStage("sess-1", attendeeId);
    await seedProcessed("sess-1", attendeeId);
    // A regular processed_payments row whose payment_reference is corrupt
    // hybrid ciphertext — would break the refund-target migration, so it must
    // fail readiness now (not only merge-reference handoffs are verified).
    await execute(
      `UPDATE processed_payments SET payment_reference = 'hyb:1:corrupt'
        WHERE payment_session_id = 'sess-1'`,
    );

    const { out, result } = await runOwner();

    expect(result).toBe(1);
    expect(out).toContain(
      "captured charge reference that did not decrypt: sess-1",
    );
  });

  test("does not treat a servicing row as a valid payment attendee", async () => {
    // Seed a servicing (van/crew) attendee and point a processed payment at it.
    // Servicing rows are not real payment targets, so readiness must block.
    await execute(
      "INSERT INTO attendees (created, kind, pii_blob) VALUES (?, 'servicing', '')",
      [nowIso()],
    );
    const servicing = await queryOne<{ id: number }>(
      "SELECT id FROM attendees WHERE kind = 'servicing' LIMIT 1",
    );
    await seedStage("sess-1", servicing!.id);
    await seedProcessed("sess-1", servicing!.id);

    const { out, result } = await runOwner(["--owner", TEST_ADMIN_USERNAME]);

    expect(result).toBe(1);
    expect(out).toContain("processed payment without a live attendee");
  });
});
