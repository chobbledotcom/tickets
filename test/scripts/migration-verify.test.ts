/**
 * The migration-readiness verifier end to end: the CLI shell against fake
 * sources (argument handling, the exit-code contract, the owner-key control),
 * then the production reader and owner key against a real test database.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { encryptWithOwnerKey } from "#crypto/hybrid.ts";
import { buildPiiBlob, encryptPiiBlob } from "#db/attendees/pii.ts";
import { getDb } from "#db/client.ts";
import { settings } from "#db/settings.ts";
import { invalidateUsersCache } from "#db/users.ts";
import {
  createMigrationVerifyOwnerKey,
  createMigrationVerifyReader,
} from "#scripts/migration-verify-deps.ts";
import {
  EXIT_BLOCKED,
  EXIT_READY,
  EXIT_USAGE,
  MIGRATION_VERIFY_USAGE,
  type MigrationVerifyDeps,
  type MigrationVerifyOwnerKey,
  type MigrationVerifyReader,
  runMigrationVerifyCli,
} from "#scripts/migration-verify-lib.ts";
import { enc, processed } from "#test/shared/migration-readiness/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
} from "#test-utils/internal.ts";
import { seedV1User } from "#test-utils/kek.ts";

const noRows = (): MigrationVerifyReader => ({
  readAttendeeIds: () => Promise.resolve(new Set<number>()),
  readAttendeePii: () => Promise.resolve([]),
  readCheckoutStages: () => Promise.resolve([]),
  readProcessedPayments: () => Promise.resolve([]),
  readSumupCheckouts: () => Promise.resolve([]),
});

const piiReader = (): Partial<MigrationVerifyDeps> => ({
  createReader: () => ({
    ...noRows(),
    readAttendeePii: () =>
      Promise.resolve([{ id: 1, pii_blob: enc("hyb:1:x") }]),
  }),
});

const chargesOnly = (): Partial<MigrationVerifyDeps> => ({
  createReader: () => ({
    ...noRows(),
    readProcessedPayments: () =>
      Promise.resolve([processed({ payment_reference: enc("hyb:1:x") })]),
  }),
});

const nullOwnerKey = (): MigrationVerifyOwnerKey => ({
  derive: () => Promise.resolve(null),
  verify: () =>
    Promise.resolve({
      undecryptablePaymentReferences: new Set<string>(),
      undecryptablePii: new Set<number>(),
    }),
});

const drive = async (
  over: Partial<MigrationVerifyDeps> = {},
): Promise<{ code: number; err: string[]; out: string[] }> => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMigrationVerifyCli({
    args: [],
    createReader: () => noRows(),
    getEnv: () => undefined,
    ownerKey: nullOwnerKey(),
    pageSize: 500,
    prompt: () => null,
    stderr: (line) => err.push(line),
    stdout: (line) => out.push(line),
    ...over,
  });
  return { code, err, out };
};

test("usage on stderr for bad arguments, on stdout for --help", async () => {
  for (const args of [["--bogus"], ["extra"], ["--page-size", "0"]]) {
    const run = await drive({ args });
    expect(run.code).toBe(EXIT_USAGE);
    expect(run.err).toEqual([MIGRATION_VERIFY_USAGE]);
  }
  const help = await drive({ args: ["--help"] });
  expect(help.code).toBe(EXIT_READY);
  expect(help.out).toEqual([MIGRATION_VERIFY_USAGE]);
});

test("a failed source read exits 2 and names the failure", async () => {
  const run = await drive({
    createReader: () => ({
      ...noRows(),
      readProcessedPayments: () => Promise.reject(new Error("db down")),
    }),
  });
  expect(run.code).toBe(EXIT_USAGE);
  expect(run.err[0]).toContain("Could not read the legacy payment sources");
});

test("blocks when no owner key is available", async () => {
  // No --owner, a blank --owner, and an empty password all leave the
  // encrypted PII unverified. Encrypted charges alone block too.
  for (const over of [
    piiReader(),
    { ...piiReader(), args: ["--owner", "   "] },
    { ...piiReader(), args: ["--owner", "jo"], prompt: () => "" },
    chargesOnly(),
  ]) {
    const run = await drive(over);
    expect(run.code).toBe(EXIT_BLOCKED);
    expect(run.out.join("\n")).toContain("owner_key_unavailable");
  }
});

test("a database with nothing encrypted is ready without the owner key", async () => {
  expect((await drive()).code).toBe(EXIT_READY);
});

test("blocks and explains when the password derives no key", async () => {
  const run = await drive({
    ...piiReader(),
    args: ["--owner", "jo"],
    prompt: () => "secret",
  });
  expect(run.code).toBe(EXIT_BLOCKED);
  expect(run.err[0]).toContain("could not be derived");
});

describeWithEnv("migration-verify production wiring", { db: true }, () => {
  const at = "2026-01-01T00:00:00.000Z";

  const seedAttendee = async (id: number, piiBlob: string): Promise<void> => {
    await getDb().execute({
      args: [id, at, piiBlob],
      sql: "INSERT INTO attendees (id, created, kind, pii_blob) VALUES (?, ?, 'attendee', ?)",
    });
  };

  const seedStaged = async (
    sessionId: string,
    attendeeId: number,
    reference = "",
  ): Promise<void> => {
    await getDb().execute({
      args: [sessionId, attendeeId, at, reference],
      sql: "INSERT INTO processed_payments (payment_session_id, attendee_id, processed_at, payment_reference) VALUES (?, ?, ?, ?)",
    });
    await getDb().execute({
      args: [sessionId, attendeeId, at],
      sql: "INSERT INTO checkout_stages (payment_session_id, attendee_id, provider, ticket_tokens, state, created_at) VALUES (?, ?, 'sumup', '', 'new', ?)",
    });
    await getDb().execute({
      args: [sessionId, at],
      sql: "INSERT INTO sumup_checkouts (reference_index, metadata, sumup_id, wrapped_key, created_at) VALUES (?, 'm', 'su-1', 'wk', ?)",
    });
  };

  const validPii = (): string =>
    buildPiiBlob({
      address: "1 Main St",
      email: "a@b.c",
      lat: "",
      lng: "",
      name: "Attendee One",
      payment_id: "pay-1",
      phone: "555",
      special_instructions: "",
      ticket_token: "tok-1",
    });

  test("the reader pages past the libsql response cap", async () => {
    for (const id of [1, 2, 3, 4]) {
      await seedAttendee(id, "blob");
      await seedStaged(`s-${id}`, id);
    }
    const reader = createMigrationVerifyReader(2);
    expect(
      (await reader.readProcessedPayments()).map((r) => r.payment_session_id),
    ).toEqual(["s-1", "s-2", "s-3", "s-4"]);
  });

  test("the reader rejects a NULL primary key", async () => {
    await getDb().execute({
      args: [at],
      sql: "INSERT INTO processed_payments (attendee_id, processed_at) VALUES (1, ?)",
    });
    await expect(
      createMigrationVerifyReader().readProcessedPayments(),
    ).rejects.toThrow("NULL primary key in payment_session_id");
  });

  test("derive returns null for every unavailable-key case", async () => {
    const ownerKey = createMigrationVerifyOwnerKey();
    expect(await ownerKey.derive("nobody", "pw")).toBeNull();
    expect(await ownerKey.derive(TEST_ADMIN_USERNAME, "wrong")).toBeNull();
    // The site key cannot be unwrapped from a corrupt wrap.
    await getDb().execute(
      "UPDATE users SET wrapped_data_key = 'corrupt-ciphertext'",
    );
    invalidateUsersCache();
    expect(
      await ownerKey.derive(TEST_ADMIN_USERNAME, TEST_ADMIN_PASSWORD),
    ).toBeNull();
    // The wrapped private key setting is absent.
    await getDb().execute(
      "DELETE FROM settings WHERE key = 'wrapped_private_key'",
    );
    settings.invalidateCache();
    expect(
      await ownerKey.derive(TEST_ADMIN_USERNAME, TEST_ADMIN_PASSWORD),
    ).toBeNull();
  });

  test("derive returns null for a non-owner", async () => {
    await seedV1User("manager-1", "manager-pw");
    expect(
      await createMigrationVerifyOwnerKey().derive("manager-1", "manager-pw"),
    ).toBeNull();
  });

  test("verify lists every source that fails under the key", async () => {
    const ownerKey = createMigrationVerifyOwnerKey();
    const key = await ownerKey.derive(TEST_ADMIN_USERNAME, TEST_ADMIN_PASSWORD);
    const corrupt = enc("hyb:1:corrupt");
    const charge = await encryptWithOwnerKey("c", settings.publicKey);
    const empty = await encryptWithOwnerKey("", settings.publicKey);
    const result = await ownerKey.verify(key!, {
      attendees: [
        {
          id: 1,
          pii_blob: await encryptPiiBlob(validPii(), settings.publicKey),
        },
        { id: 2, pii_blob: corrupt },
        { id: 3, pii_blob: enc("not-hybrid") },
      ],
      paymentReferences: [
        processed({ payment_reference: charge, payment_session_id: "ok" }),
        processed({ payment_reference: corrupt, payment_session_id: "bad" }),
        processed({ payment_reference: empty, payment_session_id: "empty" }),
        processed({ payment_session_id: "none" }),
        // A legacy plaintext reference (development builds wrote the column
        // in the clear) needs no key, so it is not a failure.
        processed({ payment_reference: enc("p"), payment_session_id: "plain" }),
      ],
    });
    expect(result.undecryptablePii).toEqual(new Set([2, 3]));
    expect(result.undecryptablePaymentReferences).toEqual(
      new Set(["bad", "empty"]),
    );
  });

  test("a consistent database verifies ready", async () => {
    await seedAttendee(1, await encryptPiiBlob(validPii(), settings.publicKey));
    await seedStaged(
      "s-1",
      1,
      await encryptWithOwnerKey("c", settings.publicKey),
    );
    const run = await drive({
      args: ["--owner", TEST_ADMIN_USERNAME, "--page-size", "1"],
      createReader: createMigrationVerifyReader,
      ownerKey: createMigrationVerifyOwnerKey(),
      prompt: () => TEST_ADMIN_PASSWORD,
    });
    expect(run.code).toBe(EXIT_READY);
    expect(run.out[0]).toBe("Payment migration readiness: ready");
  });
});
