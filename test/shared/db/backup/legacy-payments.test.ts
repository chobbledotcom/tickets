import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { unzipSync } from "fflate";
import { encrypt } from "#shared/crypto/encryption.ts";
import { createBackupZip, restoreFromZip } from "#shared/db/backup.ts";
import { getDb, queryAll, queryOne } from "#shared/db/client.ts";
import { createLegacyPaymentTables } from "#shared/db/migrations/legacy-payment-schema.ts";
import { MIGRATION_IDS } from "#shared/db/migrations/registry.ts";
import { initDb } from "#shared/db/migrations.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("old payment backup restore", { db: true }, () => {
  test("restores legacy sources for the pending aggregate migration", async () => {
    await createLegacyPaymentTables(getDb);
    await getDb().execute({
      args: [
        "backup-legacy-payment",
        "2025-01-01T00:00:00.000Z",
        await encrypt(JSON.stringify({ error: "Legacy backup failure" })),
      ],
      sql: `INSERT INTO processed_payments
        (payment_session_id, processed_at, failure_data) VALUES (?, ?, ?)`,
    });
    const aggregateIndex = MIGRATION_IDS.indexOf(
      "2026-07-26_payment_aggregate",
    );
    const pendingIds = MIGRATION_IDS.slice(aggregateIndex);
    await getDb().execute({
      args: pendingIds,
      sql: `DELETE FROM schema_migrations
        WHERE id IN (${pendingIds.map(() => "?").join(", ")})`,
    });
    await getDb().execute(
      "UPDATE settings SET value = 'old-payment-backup' WHERE key IN ('latest_db_update', 'db_schema_hash')",
    );
    await getDb().execute(
      "CREATE TABLE unrelated_retired_table (id INTEGER PRIMARY KEY)",
    );
    await getDb().execute("INSERT INTO unrelated_retired_table DEFAULT VALUES");

    const zip = await createBackupZip();
    const files = unzipSync(zip);
    expect(Object.keys(files)).toContain("processed_payments.sql");
    expect(Object.keys(files)).not.toContain("unrelated_retired_table.sql");

    await restoreFromZip(zip);

    expect(
      await queryOne<{ id: string }>(
        "SELECT payment_session_id AS id FROM processed_payments",
      ),
    ).toEqual({ id: "backup-legacy-payment" });

    await initDb();

    const legacyTables = await queryAll<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table'
        AND name IN ('processed_payments', 'checkout_stages', 'sumup_checkouts')`,
    );
    expect(legacyTables).toEqual([]);
    expect(
      await queryOne<{ state: string }>(
        "SELECT state FROM payment_sessions WHERE origin = 'legacy'",
      ),
    ).toEqual({ state: "failed" });
  });
});
