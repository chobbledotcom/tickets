import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { recreateTable } from "#shared/db/migrations/schema-sync.ts";
import { setupTransactionalTestDb } from "#test-utils";

/**
 * recreateTable rebuilds a table, then (re)creates its indexes and triggers, all
 * inside one interactive transaction. This guards the safety property that buys:
 * if a post-rebuild step fails — e.g. a UNIQUE index cannot be built because the
 * live data has duplicates — the whole rebuild rolls back and the original table
 * is left exactly as it was, rather than committed in a half-migrated shape (the
 * renamed table missing the very index that enforces its invariant).
 *
 * `users` is used as the subject: it has a UNIQUE index (idx_users_username_index)
 * and is referenced by no triggers, so it can be rebuilt in isolation.
 */
describe("db > recreateTable atomicity", () => {
  let cleanup: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    cleanup = await setupTransactionalTestDb();
  });

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  /**
   * Bend the live `users` table into a legacy shape recreateTable must repair:
   * drop the UNIQUE index, add a column that is NOT in the current SCHEMA (so the
   * rebuild would drop it), and insert `extraRows` whose username_index values
   * decide whether the index can be rebuilt.
   */
  const seedLegacyUsers = async (usernameIndexes: string[]): Promise<void> => {
    const db = getDb();
    await db.execute("DROP INDEX idx_users_username_index");
    await db.execute(
      "ALTER TABLE users ADD COLUMN legacy_extra TEXT NOT NULL DEFAULT 'keep'",
    );
    for (const usernameIndex of usernameIndexes) {
      await db.execute({
        args: [usernameIndex],
        sql: "INSERT INTO users (username_hash, username_index, admin_level) VALUES ('h', ?, 'owner')",
      });
    }
  };

  const columnNames = async (table: string): Promise<string[]> =>
    (await getDb().execute(`PRAGMA table_info(${table})`)).rows.map((row) =>
      String(row.name),
    );

  const indexNames = async (table: string): Promise<string[]> =>
    (
      await getDb().execute({
        args: [table],
        sql: "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?",
      })
    ).rows.map((row) => String(row.name));

  test("rolls the entire rebuild back when the UNIQUE index cannot be built", async () => {
    // Two rows share a username_index, so re-creating the UNIQUE index fails.
    await seedLegacyUsers(["dup", "dup"]);

    await expect(recreateTable("users")).rejects.toThrow();

    // The rebuild dropped `legacy_extra` on the staged table; its survival proves
    // the DROP/CREATE/RENAME were rolled back, not committed-then-failed.
    expect(await columnNames("users")).toContain("legacy_extra");

    // Both duplicate rows are still present and untouched.
    const rows = await getDb().execute(
      "SELECT username_index FROM users ORDER BY id",
    );
    expect(rows.rows.map((row) => row.username_index)).toEqual(["dup", "dup"]);

    // The UNIQUE index never landed — its creation is what failed and rolled back.
    expect(await indexNames("users")).not.toContain("idx_users_username_index");

    // The staged rebuild table must not be left behind either.
    const staged = await getDb().execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users_new'",
    );
    expect(staged.rows.length).toBe(0);
  });

  test("commits the rebuilt table together with its UNIQUE index on success", async () => {
    await seedLegacyUsers(["only"]);

    await recreateTable("users");

    // The extra column is gone (rebuilt from SCHEMA) and the row survived.
    expect(await columnNames("users")).not.toContain("legacy_extra");
    const rows = await getDb().execute("SELECT username_index FROM users");
    expect(rows.rows.map((row) => row.username_index)).toEqual(["only"]);

    // The SCHEMA's UNIQUE index was (re)created in the same transaction.
    expect(await indexNames("users")).toContain("idx_users_username_index");
  });

  test("creates a current schema table when it is absent from the live database", async () => {
    await getDb().execute("DROP TABLE holidays");

    await recreateTable("holidays");

    expect(await columnNames("holidays")).toEqual([
      "id",
      "name",
      "start_date",
      "end_date",
    ]);
    const rows = await getDb().execute(
      "SELECT COUNT(*) AS count FROM holidays",
    );
    expect(Number(rows.rows[0]!.count)).toBe(0);
  });
});
