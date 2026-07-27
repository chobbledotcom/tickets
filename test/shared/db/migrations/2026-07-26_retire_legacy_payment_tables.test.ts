import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import paymentAggregateMigration from "#shared/db/migrations/2026-07-26_payment_aggregate.ts";
import retireLegacyPaymentTablesMigration from "#shared/db/migrations/2026-07-26_retire_legacy_payment_tables.ts";
import { LEGACY_PAYMENT_TABLE_NAMES } from "#shared/db/migrations/legacy-payment-schema.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  context,
  restoreLegacyPaymentSources,
} from "./payment-aggregate-test-utils.ts";

const sourceTables = async (): Promise<string[]> => {
  const result = await getDb().execute({
    args: LEGACY_PAYMENT_TABLE_NAMES,
    sql: `SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN (${LEGACY_PAYMENT_TABLE_NAMES.map(() => "?").join(", ")})
      ORDER BY name`,
  });
  return result.rows.map((row) => String(row.name));
};

const blockerTriggers = async (): Promise<string[]> => {
  const result = await getDb().execute(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'payment_aggregate_block_%' ORDER BY name",
  );
  return result.rows.map((row) => String(row.name));
};

describeWithEnv("retire legacy payment tables migration", { db: true }, () => {
  beforeEach(restoreLegacyPaymentSources);

  test("declares every retired source absent", () => {
    const migration = retireLegacyPaymentTablesMigration(context);
    expect(migration.requires).toEqual({
      absentTables: LEGACY_PAYMENT_TABLE_NAMES,
    });
  });

  test("drops verified drained sources and their blockers", async () => {
    await getDb().execute(`INSERT INTO processed_payments
      (payment_session_id, processed_at, failure_data)
      VALUES ('retired-payment', '2026-07-25T10:00:00.000Z',
        'enc:1:legacy-failure')`);
    const aggregate = paymentAggregateMigration(context);
    await aggregate.up();
    await aggregate.verify();

    const retire = retireLegacyPaymentTablesMigration(context);
    await retire.up();
    await retire.verify();

    expect(await sourceTables()).toEqual([]);
    expect(await blockerTriggers()).toEqual([]);
    const copied = await getDb().execute(
      "SELECT state FROM payment_sessions WHERE origin = 'legacy'",
    );
    expect(copied.rows).toEqual([{ state: "failed" }]);
  });

  test("refuses to drop a source that was not drained", async () => {
    await getDb().execute(`INSERT INTO processed_payments
      (payment_session_id, processed_at)
      VALUES ('not-drained', '2026-07-25T10:00:00.000Z')`);

    const retire = retireLegacyPaymentTablesMigration(context);
    await expect(retire.up()).rejects.toThrow(
      "Legacy payment sources were not fully drained",
    );

    expect(await sourceTables()).toEqual([
      "checkout_stages",
      "processed_payments",
      "sumup_checkouts",
    ]);
    await expect(
      getDb().execute(`UPDATE processed_payments SET processed_at = processed_at
        WHERE payment_session_id = 'not-drained'`),
    ).rejects.toThrow("legacy payment source is closed");
  });

  test("retries safely after the tables dropped before the marker", async () => {
    const retire = retireLegacyPaymentTablesMigration(context);
    await retire.up();
    expect(await sourceTables()).toEqual([]);

    await retire.up();
    await retire.verify();

    expect(await sourceTables()).toEqual([]);
  });

  test("treats partially absent sources as empty", async () => {
    await getDb().execute("DROP TABLE processed_payments");
    const retire = retireLegacyPaymentTablesMigration(context);

    await retire.up();
    await retire.verify();

    expect(await sourceTables()).toEqual([]);
  });
});
