import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { getDb } from "#shared/db/client.ts";
import loginAttemptStampMigration from "#shared/db/migrations/2026-08-04_login_attempt_stamp.ts";
import {
  applySchemaChanges,
  syncIndexes,
} from "#shared/db/migrations/schema-sync.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const context = buildMigrationContext({ applySchemaChanges, syncIndexes });
const runMigration = (): Promise<void> =>
  loginAttemptStampMigration(context).up();

const insertRow = (ip: string, lastAttempt: number) =>
  getDb().execute({
    args: [ip, lastAttempt],
    sql: "INSERT INTO login_attempts (ip, attempts, locked_until, last_attempt) VALUES (?, 2, NULL, ?)",
  });

const storedStamp = async (ip: string): Promise<number> => {
  const result = await getDb().execute({
    args: [ip],
    sql: "SELECT last_attempt FROM login_attempts WHERE ip = ?",
  });
  return Number(result.rows[0]!.last_attempt);
};

describeWithEnv("db > migrations > login attempt stamp", { db: true }, () => {
  test("declares its identity, column, and index", () => {
    const migration = loginAttemptStampMigration(context);
    expect({
      description: migration.description,
      id: migration.id,
      requires: migration.requires,
    }).toEqual({
      description: "Track when each login-attempt row was last touched.",
      id: "2026-08-04_login_attempt_stamp",
      requires: {
        columns: { login_attempts: ["last_attempt"] },
        indexes: ["idx_login_attempts_last_attempt"],
      },
    });
  });

  test("starts the clock on rows that predate the stamp", async () => {
    using _time = new FakeTime(1_800_000_000_000);
    await insertRow("legacy-row", 0);

    await runMigration();

    // A legacy counter must age out one retention period from the
    // migration, not be prunable immediately.
    expect(await storedStamp("legacy-row")).toBe(1_800_000_000_000);
  });

  test("leaves already-stamped rows alone", async () => {
    await insertRow("stamped-row", 1_700_000_000_000);

    await runMigration();

    expect(await storedStamp("stamped-row")).toBe(1_700_000_000_000);
  });
});
