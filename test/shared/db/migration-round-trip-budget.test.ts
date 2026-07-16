import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { executeBatch, getDb, inPlaceholders } from "#shared/db/client.ts";
import { MIGRATION_IDS } from "#shared/db/migrations/registry.ts";
import {
  initDb,
  invalidateInitDbCache,
  LATEST_UPDATE,
  MigrationInProgressError,
} from "#shared/db/migrations.ts";
import { runWithQueryLogContext } from "#shared/db/query-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const LISTINGS_TAG_MIGRATION_ID = "2026-07-03_attendee_listings_tag";
const LISTINGS_TAG_REVISION =
  "Rewrite the {{listing}} attendee column-order tag to {{listings}} for the grouped Listings column.";

const migrationsAfterListingsTag = (): string[] => {
  const appliedIndex = MIGRATION_IDS.indexOf(LISTINGS_TAG_MIGRATION_ID);
  if (appliedIndex < 0) {
    throw new Error(`Missing migration ${LISTINGS_TAG_MIGRATION_ID}`);
  }
  return MIGRATION_IDS.slice(appliedIndex + 1);
};

describeWithEnv("migration request round-trip budget", { db: true }, () => {
  test("upgrades the listings-tag revision within guarded edge requests", async () => {
    const pendingIds = migrationsAfterListingsTag();
    await executeBatch([
      {
        args: [LISTINGS_TAG_REVISION],
        sql: "UPDATE settings SET value = ? WHERE key = 'latest_db_update'",
      },
      {
        args: pendingIds,
        sql: `DELETE FROM schema_migrations WHERE id IN (${inPlaceholders(pendingIds)})`,
      },
    ]);
    invalidateInitDbCache();

    let continuations = 0;
    let finished = false;
    for (let attempt = 0; attempt < pendingIds.length; attempt += 1) {
      try {
        await runWithQueryLogContext(() => initDb());
        finished = true;
        break;
      } catch (error) {
        expect(error).toBeInstanceOf(MigrationInProgressError);
        continuations += 1;
      }
    }
    expect(finished).toBe(true);
    expect(continuations).toBe(3);

    const result = await getDb().execute({
      args: pendingIds,
      sql: `SELECT id FROM schema_migrations WHERE id IN (${inPlaceholders(pendingIds)}) ORDER BY id`,
    });
    expect(result.rows.map((row) => String(row.id))).toEqual(
      [...pendingIds].sort(),
    );
    const marker = await getDb().execute(
      "SELECT value FROM settings WHERE key = 'latest_db_update'",
    );
    expect(marker.rows[0]?.value).toBe(LATEST_UPDATE);
  });
});
