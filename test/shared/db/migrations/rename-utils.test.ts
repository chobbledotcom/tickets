import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { execute, queryAll } from "#db/client.ts";
import { repairLegacyRenames } from "#db/migrations/rename-utils.ts";
import { describeWithEnv } from "#test-utils/db.ts";

/** The tables this file makes, dropped before each case so one test never
 * inherits another's half-renamed schema. */
const SCRATCH = ["legacy_things", "target_things"];

const dropScratch = async (): Promise<void> => {
  for (const table of SCRATCH) {
    await execute(`DROP TABLE IF EXISTS ${table}`);
  }
};

const makeTable = async (name: string, columns: string): Promise<void> => {
  await execute(`CREATE TABLE ${name} (${columns})`);
};

const tableNames = async (): Promise<string[]> =>
  (
    await queryAll<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('${SCRATCH.join("','")}')`,
    )
  ).map((row) => row.name);

const columnNames = async (table: string): Promise<string[]> =>
  (await queryAll<{ name: string }>(`PRAGMA table_info(${table})`)).map(
    (row) => row.name,
  );

const rowCount = async (table: string): Promise<number> =>
  (await queryAll<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))[0]?.n ??
  0;

const renameTable = {
  columnRenames: [],
  tableRenames: [["legacy_things", "target_things"]],
} as const;

describeWithEnv("db > legacy rename repair", { db: true }, () => {
  describe("a table rename", () => {
    test("renames the legacy table when only it is there", async () => {
      await dropScratch();
      await makeTable("legacy_things", "id INTEGER PRIMARY KEY, name TEXT");
      await execute("INSERT INTO legacy_things (id, name) VALUES (1, 'kept')");

      await repairLegacyRenames(renameTable);

      expect(await tableNames()).toEqual(["target_things"]);
      expect(await rowCount("target_things")).toBe(1);
      await dropScratch();
    });

    test("changes nothing when the target is already there alone", async () => {
      await dropScratch();
      await makeTable("target_things", "id INTEGER PRIMARY KEY, name TEXT");
      await execute("INSERT INTO target_things (id, name) VALUES (1, 'kept')");

      await repairLegacyRenames(renameTable);

      expect(await tableNames()).toEqual(["target_things"]);
      expect(await rowCount("target_things")).toBe(1);
      await dropScratch();
    });

    test("changes nothing when neither table is there", async () => {
      await dropScratch();
      await repairLegacyRenames(renameTable);
      expect(await tableNames()).toEqual([]);
    });
  });

  describe("a column rename", () => {
    const renameColumn = {
      columnRenames: [["target_things", "old_name", "new_name"]],
      tableRenames: [],
    } as const;

    test("renames the legacy column when only it is there", async () => {
      await dropScratch();
      await makeTable("target_things", "id INTEGER PRIMARY KEY, old_name TEXT");
      await execute(
        "INSERT INTO target_things (id, old_name) VALUES (1, 'kept')",
      );

      await repairLegacyRenames(renameColumn);

      expect(await columnNames("target_things")).toEqual(["id", "new_name"]);
      expect(
        (
          await queryAll<{ new_name: string }>(
            "SELECT new_name FROM target_things",
          )
        )[0]?.new_name,
      ).toBe("kept");
      await dropScratch();
    });

    test("changes nothing when the target column is already there alone", async () => {
      await dropScratch();
      await makeTable("target_things", "id INTEGER PRIMARY KEY, new_name TEXT");

      await repairLegacyRenames(renameColumn);

      expect(await columnNames("target_things")).toEqual(["id", "new_name"]);
      await dropScratch();
    });

    test("changes nothing when the table itself is not there", async () => {
      await dropScratch();
      await repairLegacyRenames(renameColumn);
      expect(await tableNames()).toEqual([]);
    });
  });
});
