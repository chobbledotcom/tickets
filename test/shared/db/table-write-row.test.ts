import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, queryAll, withTransaction } from "#shared/db/client.ts";
import { col, defineTable, writeTableRow } from "#shared/db/table.ts";
import { describeWithEnv } from "#test-utils/db.ts";

type WriteRow = { id: number; name: string };
type WriteInput = { name: string };

const createWriteTable = async () => {
  await execute(
    "CREATE TABLE table_write_rows (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
  );
  return defineTable<WriteRow, WriteInput>({
    name: "table_write_rows",
    primaryKey: "id",
    schema: {
      id: col.generated<number>(),
      name: col.transform(
        (value: string) => value.toUpperCase(),
        (value: string) => value.toLowerCase(),
      ),
    },
  });
};

describeWithEnv("db > writeTableRow", { db: true }, () => {
  test("inserts and reads back every selected table column", async () => {
    const table = await createWriteTable();
    const row = await withTransaction((transaction) =>
      writeTableRow(transaction, table, {
        input: { name: "First" },
        kind: "insert",
      }),
    );

    expect(row).toEqual({ id: 1, name: "first" });
    expect(await queryAll("SELECT id, name FROM table_write_rows")).toEqual([
      { id: 1, name: "FIRST" },
    ]);
  });

  test("updates and reads back the changed row", async () => {
    const table = await createWriteTable();
    const inserted = await table.insert({ name: "Before" });
    const row = await withTransaction((transaction) =>
      writeTableRow(transaction, table, {
        id: inserted.id,
        input: { name: "After" },
        kind: "update",
      }),
    );

    expect(row).toEqual({ id: inserted.id, name: "after" });
  });

  test("returns null when an insert condition rejects the row", async () => {
    const table = await createWriteTable();
    const row = await withTransaction((transaction) =>
      writeTableRow(transaction, table, {
        condition: { args: [], sql: "0" },
        input: { name: "Skipped" },
        kind: "insert",
      }),
    );

    expect(row).toBeNull();
    expect(await queryAll("SELECT id, name FROM table_write_rows")).toEqual([]);
  });
});
