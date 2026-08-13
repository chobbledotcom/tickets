import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import paymentWorkQueueIndex from "#shared/db/migrations/2026-08-13_payment_work_queue_index.ts";
import { syncIndexes } from "#shared/db/migrations/schema-sync.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const INDEX = "idx_processed_payments_protected_attendee";
const context = buildMigrationContext({ syncIndexes });

const storedIndexSql = async (): Promise<string> => {
  const result = await getDb().execute({
    args: [INDEX],
    sql: "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
  });
  return String(result.rows[0]?.sql ?? "");
};

describeWithEnv(
  "db > migrations > payment-work queue index",
  { db: true },
  () => {
    test("fresh installs carry the declared partial index", async () => {
      expect(await storedIndexSql()).toBe(
        `CREATE INDEX ${INDEX} ON processed_payments(attendee_id) WHERE protected_state != ''`,
      );
    });

    test("an upgraded database gains that same partial index", async () => {
      await getDb().execute(`DROP INDEX ${INDEX}`);

      const migration = paymentWorkQueueIndex(context);
      await migration.up();
      await migration.verify();

      expect(await storedIndexSql()).toContain(
        `ON processed_payments(attendee_id) WHERE protected_state != ''`,
      );
    });

    test("declares the one index it owns", () => {
      const migration = paymentWorkQueueIndex(context);
      expect(migration).toMatchObject({
        id: "2026-08-13_payment_work_queue_index",
        requires: { indexes: [INDEX] },
      });
    });
  },
);
