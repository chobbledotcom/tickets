import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  createMigrationVerifyOwnerKey,
  createMigrationVerifyReader,
} from "#scripts/migration-verify-deps.ts";
import { runMigrationVerifyCli } from "#scripts/migration-verify-lib.ts";
import { encryptWithOwnerKey } from "#shared/crypto/keys.ts";
import { buildPiiBlob, encryptPiiBlob } from "#shared/db/attendees/pii.ts";
import { execute } from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
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
    getEnv: () => undefined,
    ownerKey: createMigrationVerifyOwnerKey(),
    pageSize,
    prompt: () => clip.promptResponse,
    reader: createMigrationVerifyReader(pageSize),
    stderr: (line) => clip.errors.push(line),
    stdout: (line) => clip.output.push(line),
  });

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
    const result = await run(c);

    expect(result).toBe(1);
    expect(c.errors.join("\n")).toContain("could not be derived");
    expect(c.output.join("\n")).toContain("owner key not supplied");
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

    const c = clip(["--owner", TEST_ADMIN_USERNAME], TEST_ADMIN_PASSWORD);
    const result = await run(c);

    expect(result).toBe(0);
    expect(c.output.join("\n")).toContain("merge references: 1");
  });
});
