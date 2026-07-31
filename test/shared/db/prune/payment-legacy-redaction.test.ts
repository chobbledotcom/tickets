import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { encrypt } from "#shared/crypto/encryption.ts";
import { deleteAttendee } from "#shared/db/attendees/delete.ts";
import { getDb, queryOne } from "#shared/db/client.ts";
import retireLegacyPaymentTablesMigration from "#shared/db/migrations/2026-07-26_retire_legacy_payment_tables.ts";
import { paymentStoredJson } from "#shared/db/payments/codecs.ts";
import { getLegacyPaymentsByIds } from "#shared/db/payments/legacy-sessions.ts";
import { runDatabasePruning } from "#shared/db/prune.ts";
import { PRUNE_UNUSED_STRINGS_RETENTION_MS } from "#shared/limits.ts";
import { nowMs } from "#shared/now.ts";
import { legacyPaymentResult } from "#shared/payment-runtime/legacy-replay.ts";
import {
  context,
  restoreLegacyPaymentSources,
  runMigration,
  seedLegacyPaidAttendee,
} from "#test/shared/db/migrations/payment-aggregate-test-utils.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { insertString, stringExists } from "./helpers.ts";
import { oldPaymentTime, redactedAt } from "./payment-redaction-helpers.ts";

const migrateAndRetire = async (): Promise<void> => {
  await runMigration();
  const retire = retireLegacyPaymentTablesMigration(context);
  await retire.up();
  await retire.verify();
};

const migrateConsumedLegacyPayment = async (): Promise<string> => {
  await migrateAndRetire();
  const stored = await queryOne<{ id: string }>(
    "SELECT id FROM payment_sessions WHERE origin = 'legacy'",
  );
  if (stored === null) throw new Error("Expected copied legacy payment");
  await getDb().execute({
    args: [stored.id],
    sql: `UPDATE payment_sessions
      SET ticket_state = 'consumed', ticket_tokens = NULL WHERE id = ?`,
  });
  return stored.id;
};

describeWithEnv("db > legacy payment redaction", { db: true }, () => {
  test("keeps a failed legacy replay after removing its private failure", async () => {
    await restoreLegacyPaymentSources();
    const privateFailure = "Private failure for alice@example.com";
    await getDb().execute({
      args: [
        "old-failed-payment",
        "2025-01-01T00:00:00.000Z",
        await encrypt(JSON.stringify({ error: privateFailure, status: 409 })),
      ],
      sql: `INSERT INTO processed_payments
        (payment_session_id, processed_at, failure_data) VALUES (?, ?, ?)`,
    });
    await migrateAndRetire();
    const stored = await queryOne<{ id: string; legacy_runtime: string }>(
      "SELECT id, legacy_runtime FROM payment_sessions WHERE origin = 'legacy'",
    );
    if (stored === null) throw new Error("Expected copied legacy payment");

    await runDatabasePruning();

    const redacted = await queryOne<{
      legacy_runtime: string;
      redacted_at: number | null;
    }>(
      "SELECT legacy_runtime, redacted_at FROM payment_sessions WHERE id = ?",
      [stored.id],
    );
    expect(redacted?.redacted_at).not.toBeNull();
    expect(redacted?.legacy_runtime).not.toBe(stored.legacy_runtime);
    const [payment] = await getLegacyPaymentsByIds([stored.id]);
    if (payment === undefined) {
      throw new Error("Expected redacted legacy payment");
    }
    const result = await legacyPaymentResult(payment);
    expect(result).toEqual({
      error: "This payment could not be completed.",
      status: 409,
      success: false,
    });
    expect(JSON.stringify(payment.runtime)).not.toContain(privateFailure);
  });

  test("keeps a completed legacy replay after removing private tickets", async () => {
    await restoreLegacyPaymentSources();
    await seedLegacyPaidAttendee();
    const privateTickets = await encrypt("private-legacy-ticket");
    await getDb().batch(
      [
        {
          args: [
            "old-completed-payment",
            42,
            "stripe",
            privateTickets,
            "2025-01-01T00:00:00.000Z",
          ],
          sql: `INSERT INTO checkout_stages
            (payment_session_id, attendee_id, provider, ticket_tokens, state, created_at)
            VALUES (?, ?, ?, ?, 'pending', ?)`,
        },
        {
          args: [
            "old-completed-payment",
            42,
            "2025-01-01T00:01:00.000Z",
            privateTickets,
          ],
          sql: `INSERT INTO processed_payments
            (payment_session_id, attendee_id, processed_at, ticket_tokens)
            VALUES (?, ?, ?, ?)`,
        },
      ],
      "write",
    );
    const storedId = await migrateConsumedLegacyPayment();

    const first = await runDatabasePruning();
    await runDatabasePruning(first.checkpoint);

    const [payment] = await getLegacyPaymentsByIds([storedId]);
    if (payment === undefined) {
      throw new Error("Expected redacted legacy payment");
    }
    if (payment.runtime.processedPayment === null) {
      throw new Error("Expected redacted processed payment");
    }
    expect(payment.provider).toBe("stripe");
    expect(payment.runtime.processedPayment.ticketTokens).toBe("");
    expect(await legacyPaymentResult(payment)).toEqual({
      attendee: { id: 42 },
      listingId: 7,
      success: true,
      ticketTokens: [],
    });
  });

  test("redacts after attendee deletion and continues other prune work", async () => {
    await restoreLegacyPaymentSources();
    await seedLegacyPaidAttendee();
    await getDb().execute({
      args: ["detached-completed", 42, "2025-01-01T00:00:00.000Z"],
      sql: `INSERT INTO processed_payments
        (payment_session_id, attendee_id, processed_at) VALUES (?, ?, ?)`,
    });
    const storedId = await migrateConsumedLegacyPayment();
    await deleteAttendee(42);
    await insertString(
      "prune-beside-detached-payment",
      new Date(
        nowMs() - PRUNE_UNUSED_STRINGS_RETENTION_MS - 60_000,
      ).toISOString(),
      0,
    );

    await runDatabasePruning();

    expect(await redactedAt(storedId)).not.toBeNull();
    expect(await stringExists("prune-beside-detached-payment")).toBe(false);
    const [payment] = await getLegacyPaymentsByIds([storedId]);
    if (payment === undefined) throw new Error("Expected detached payment");
    expect(await legacyPaymentResult(payment)).toEqual({
      attendee: { id: 42 },
      listingId: 7,
      success: true,
      ticketTokens: [],
    });
  });

  test("rejects a terminal legacy session without a processed row", async () => {
    const id = "legacy-without-processed-row";
    const runtime = await paymentStoredJson.legacyRuntime.seal(
      {
        attendeePayment: null,
        checkoutStage: {
          attendeeId: 42,
          createdAt: "2025-01-01T00:00:00.000Z",
          paymentSessionId: id,
          provider: "stripe",
          state: "pending",
          ticketTokens: await encrypt(""),
        },
        processedPayment: null,
        sumupCheckout: null,
      },
      "legacy payment redaction test",
    );
    const createdAt = oldPaymentTime();
    await getDb().execute({
      args: [
        id,
        createdAt,
        createdAt,
        await encrypt('{"error":"failed"}'),
        runtime,
      ],
      sql: `INSERT INTO payment_sessions
        (id, origin, provider, state, revision, created_at, updated_at,
         result_state, result, ticket_state, completion_state, legacy_runtime)
        VALUES (?, 'legacy', 'stripe', 'failed', 1, ?, ?, 'failed', ?,
                'none', 'none', ?)`,
    });

    await expect(runDatabasePruning()).rejects.toThrow(
      `Terminal legacy payment ${id} has no processed row`,
    );

    expect(await redactedAt(id)).toBeNull();
  });
});
