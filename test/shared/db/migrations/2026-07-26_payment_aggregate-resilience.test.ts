import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import { encrypt } from "#shared/crypto/encryption.ts";
import { getDb } from "#shared/db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  insertProcessedRow,
  MORE_THAN_ONE_INVOCATION,
  restoreLegacyPaymentSources,
  runMigration,
  runMigrationInvocation,
  seedSumupCheckouts,
} from "./payment-aggregate-test-utils.ts";

const copiedCount = async (): Promise<number> => {
  const result = await getDb().execute(
    "SELECT COUNT(*) AS count FROM payment_sessions WHERE origin = 'legacy'",
  );
  return Number(result.rows[0]?.count);
};

const expectCopiedAndDrained = async (sourceTable: string): Promise<void> => {
  const [sessions, source] = await getDb().batch(
    [
      "SELECT origin FROM payment_sessions WHERE origin = 'legacy'",
      `SELECT COUNT(*) AS count FROM ${sourceTable}`,
    ],
    "read",
  );
  if (sessions === undefined || source === undefined) {
    throw new Error("Expected migration copy and source count results");
  }
  expect(sessions.rows).toEqual([{ origin: "legacy" }]);
  expect(source.rows).toEqual([{ count: 0 }]);
};

describeWithEnv("payment aggregate migration resilience", { db: true }, () => {
  beforeEach(restoreLegacyPaymentSources);

  test("copies a staged payment after the processed source was removed", async () => {
    await getDb().execute("DROP TABLE processed_payments");
    await getDb().execute({
      args: [
        "stage-without-processed-table",
        42,
        "stripe",
        await encrypt("private-ticket"),
        "2026-07-25T11:00:00.000Z",
      ],
      sql: `INSERT INTO checkout_stages
        (payment_session_id, attendee_id, provider, ticket_tokens, state, created_at)
        VALUES (?, ?, ?, ?, 'pending', ?)`,
    });

    await runMigration();

    const sessions = await getDb().execute(
      "SELECT origin, state FROM payment_sessions WHERE origin = 'legacy'",
    );
    expect(sessions.rows).toEqual([{ origin: "legacy", state: "pending" }]);
    const source = await getDb().execute(
      "SELECT COUNT(*) AS count FROM checkout_stages",
    );
    expect(source.rows).toEqual([{ count: 0 }]);
  });

  test("rejects a source row that cannot be drained after copying", async () => {
    await insertProcessedRow();
    await getDb().execute(`CREATE TRIGGER keep_legacy_payment_source
      BEFORE DELETE ON processed_payments
      BEGIN SELECT RAISE(IGNORE); END`);

    await expect(runMigration()).rejects.toThrow(
      "A legacy payment changed before it could be drained",
    );

    const source = await getDb().execute(
      "SELECT payment_session_id FROM processed_payments",
    );
    expect(source.rows).toEqual([
      { payment_session_id: "one-processed-payment" },
    ]);
  });

  test("copies a processed payment without checkout or SumUp sources", async () => {
    await getDb().execute("DROP TABLE checkout_stages");
    await getDb().execute("DROP TABLE sumup_checkouts");
    await insertProcessedRow();

    await runMigration();

    await expectCopiedAndDrained("processed_payments");
  });

  test("copies a SumUp row when both session-id sources are absent", async () => {
    await getDb().execute("DROP TABLE processed_payments");
    await getDb().execute("DROP TABLE checkout_stages");
    await getDb().execute({
      args: [
        "sumup-only-reference",
        "wk:1:sumup-only-key",
        await encrypt('{"private":"metadata"}'),
        "sumup-only-id",
        "2026-07-25T12:00:00.000Z",
      ],
      sql: `INSERT INTO sumup_checkouts
        (reference_index, wrapped_key, metadata, sumup_id, created_at)
        VALUES (?, ?, ?, ?, ?)`,
    });

    await runMigration();

    await expectCopiedAndDrained("sumup_checkouts");
  });
  test("asks to be called again when there are more SumUp rows than one go", async () => {
    // The migration only gets so much time per request, so it copies a few
    // pages and then asks to be called again rather than running over.
    await getDb().execute("DROP TABLE processed_payments");
    await getDb().execute("DROP TABLE checkout_stages");
    await seedSumupCheckouts(MORE_THAN_ONE_INVOCATION);

    await expect(runMigrationInvocation()).rejects.toThrow(
      "continuing on the next request",
    );
    expect(await copiedCount()).toBeLessThan(MORE_THAN_ONE_INVOCATION);

    // Called again as it asked, it picks up where it stopped and finishes.
    await runMigration();
    expect(await copiedCount()).toBe(MORE_THAN_ONE_INVOCATION);
  });
});
