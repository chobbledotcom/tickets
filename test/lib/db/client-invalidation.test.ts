import { expect } from "@std/expect";
import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import {
  registerTableInvalidation,
  resetCacheRegistry,
} from "#shared/cache-registry.ts";
import { execute, executeBatch } from "#shared/db/client.ts";
import { describeWithEnv } from "#test-utils";

/**
 * Verb- and column-driven cache invalidation: after every write, the db client
 * classifies the statement's verb and (for UPDATEs) its SET columns, so a
 * column-gated registration fires only when a gated column is actually
 * assigned — while INSERT / DELETE / REPLACE always fire. These tests pin the
 * verb classification in `invalidateForSql` (src/shared/db/client.ts) through
 * the public execute() + registry API.
 */
describeWithEnv("db > client write invalidation", { db: true }, () => {
  beforeEach(() => resetCacheRegistry());
  afterEach(() => resetCacheRegistry());

  /** Register an invalidation on `settings` and count its firings. */
  const countFirings = (whenColumns?: readonly string[]): { fired: number } => {
    const counter = { fired: 0 };
    registerTableInvalidation(
      ["settings"],
      () => {
        counter.fired++;
      },
      { whenColumns },
    );
    return counter;
  };

  const SETTINGS_INSERT = "INSERT INTO settings (key, value) VALUES (?, ?)";

  const seedRow = (key: string): Promise<unknown> =>
    execute(SETTINGS_INSERT, [key, "seed"]);

  test("INSERT fires an unconditional invalidator", async () => {
    const counter = countFirings();
    await seedRow("inv_insert");
    expect(counter.fired).toBe(1);
  });

  test("UPDATE assigning a gated column fires the gated invalidator", async () => {
    await seedRow("inv_update_hit");
    const counter = countFirings(["value"]);
    await execute("UPDATE settings SET value = ? WHERE key = ?", [
      "new",
      "inv_update_hit",
    ]);
    expect(counter.fired).toBe(1);
  });

  test("UPDATE assigning only ungated columns skips the gated invalidator", async () => {
    await seedRow("inv_update_miss");
    const counter = countFirings(["some_other_column"]);
    await execute("UPDATE settings SET value = ? WHERE key = ?", [
      "new",
      "inv_update_miss",
    ]);
    // The gate must apply: misclassifying the UPDATE's verb (or dropping the
    // parsed columns) would fire this unconditionally.
    expect(counter.fired).toBe(0);
  });

  test("a committed batch invalidates for each written statement", async () => {
    const counter = countFirings();
    await executeBatch([
      { args: ["inv_batch_1", "a"], sql: SETTINGS_INSERT },
      { args: ["inv_batch_2", "b"], sql: SETTINGS_INSERT },
    ]);
    expect(counter.fired).toBe(2);
  });

  test("DELETE fires a gated invalidator regardless of its column gate", async () => {
    await seedRow("inv_delete");
    const counter = countFirings(["some_other_column"]);
    await execute("DELETE FROM settings WHERE key = ?", ["inv_delete"]);
    // A row leaving the table always shifts aggregates, so column gates only
    // narrow UPDATEs — never DELETEs.
    expect(counter.fired).toBe(1);
  });
});
