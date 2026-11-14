import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  abortUnless,
  execute,
  executeBatch,
  executeChangedRow,
  queryOne,
} from "#db/client.ts";
import { sql } from "#db/sql.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const storedValue = async (key: string): Promise<string | null> =>
  (
    await queryOne<{ value: string }>(
      sql`SELECT value FROM settings WHERE key = ${key}`,
    )
  )?.value ?? null;

describeWithEnv("db > guarded writes", { db: true }, () => {
  test("executeChangedRow is true when the write changes a row", async () => {
    await execute(
      sql`INSERT INTO settings (key, value) VALUES ('guard_changed', 'old')`,
    );
    expect(
      await executeChangedRow(
        sql`UPDATE settings SET value = 'new' WHERE key = 'guard_changed' AND value = 'old'`,
      ),
    ).toBe(true);
    expect(await storedValue("guard_changed")).toBe("new");
  });

  test("executeChangedRow is false when the guard refuses the write", async () => {
    await execute(
      sql`INSERT INTO settings (key, value) VALUES ('guard_refused', 'new')`,
    );
    expect(
      await executeChangedRow(
        sql`UPDATE settings SET value = 'newer' WHERE key = 'guard_refused' AND value = 'old'`,
      ),
    ).toBe(false);
    expect(await storedValue("guard_refused")).toBe("new");
  });

  const settingsGuard = abortUnless(
    sql`settings (key, value)`,
    sql`${"guard_probe"}, NULL`,
  );

  test("abortUnless writes nothing and lets the batch land when the condition holds", async () => {
    await executeBatch([
      sql`INSERT INTO settings (key, value) VALUES ('guard_held', 'x')`,
      settingsGuard(sql`1 = 1`),
    ]);
    expect(await storedValue("guard_held")).toBe("x");
    expect(await storedValue("guard_probe")).toBeNull();
  });

  test("abortUnless aborts the whole batch when the condition fails", async () => {
    await expect(
      executeBatch([
        sql`INSERT INTO settings (key, value) VALUES ('guard_failed', 'x')`,
        settingsGuard(sql`1 = 0`),
      ]),
    ).rejects.toThrow("NOT NULL");
    expect(await storedValue("guard_failed")).toBeNull();
  });

  test("abortUnless builds one INSERT that selects the row only when the condition fails", () => {
    expect(settingsGuard(sql`id = ${5}`)).toEqual(
      sql`INSERT INTO settings (key, value) SELECT ${"guard_probe"}, NULL WHERE NOT (id = ${5})`,
    );
  });
});
