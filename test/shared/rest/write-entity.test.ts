import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { col, defineTable, type Table } from "#shared/db/table.ts";
import { type EntityWrite, writeEntity } from "#shared/rest/write-entity.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";

type Row = { id: number; name: string };
type Input = { name: string };

const makeTable = (): Table<Row, Input> =>
  defineTable<Row, Input>({
    name: "we_items",
    primaryKey: "id",
    schema: { id: col.generated<number>(), name: col.simple<string>() },
  });

const createTable = async (): Promise<void> => {
  await getDb().execute(
    "CREATE TABLE IF NOT EXISTS we_items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)",
  );
};

const reject = (what: string) => () =>
  Promise.reject(new Error(`${what} must not run`));

/** Call writeEntity with safe defaults, overriding only what a case exercises. */
const writeWith = (
  table: Table<Row, Input>,
  overrides: Partial<EntityWrite<Row>>,
): Promise<Row | null> =>
  writeEntity<Row>({
    buildStatement: () => table.insertStatement!({ name: "row" }),
    existingId: null,
    joinWrite: () => Promise.resolve(),
    plainWrite: () => table.insert({ name: "row" }),
    readBack: (id) => table.findByIdPrimary!(id),
    transactional: false,
    ...overrides,
  });

describe("writeEntity", () => {
  beforeEach(async () => {
    await createTestDb();
    await createTable();
  });
  afterEach(() => resetDb());

  test("transactional path: writes the row, runs the join write in-tx, reads back on the primary", async () => {
    const table = makeTable();
    const joinIds: number[] = [];
    const afterCommitIds: number[] = [];

    const row = await writeWith(table, {
      afterCommit: (id) => {
        afterCommitIds.push(id);
        return Promise.resolve();
      },
      joinWrite: (_tx, id) => {
        joinIds.push(id);
        return Promise.resolve();
      },
      plainWrite: reject("plainWrite"),
      transactional: true,
    });

    expect(row).toEqual({ id: 1, name: "row" });
    // The join write saw the just-inserted row's id, inside the transaction.
    expect(joinIds).toEqual([1]);
    // afterCommit ran once with the written row's id, after the read-back.
    expect(afterCommitIds).toEqual([1]);
    expect(await table.findById(1)).toEqual({ id: 1, name: "row" });
  });

  test("transactional path rolls the row back when the join write throws", async () => {
    const table = makeTable();
    let afterCommitRan = false;

    await expect(
      writeWith(table, {
        afterCommit: () => {
          afterCommitRan = true;
          return Promise.resolve();
        },
        joinWrite: () => Promise.reject(new Error("join failed")),
        plainWrite: reject("plainWrite"),
        transactional: true,
      }),
    ).rejects.toThrow("join failed");

    // The row write rolled back with the failed join write; nothing persisted,
    // and the post-commit hook never ran.
    expect(await table.findById(1)).toBeNull();
    expect(afterCommitRan).toBe(false);
  });

  test("plain path: uses plainWrite, skips the statement/join hooks, still runs afterCommit", async () => {
    const table = makeTable();
    let buildStatementRan = false;
    const afterCommitIds: number[] = [];

    const row = await writeWith(table, {
      afterCommit: (id) => {
        afterCommitIds.push(id);
        return Promise.resolve();
      },
      buildStatement: () => {
        buildStatementRan = true;
        return table.insertStatement!({ name: "row" });
      },
      joinWrite: reject("joinWrite"),
      readBack: reject("readBack"),
      transactional: false,
    });

    expect(row).toEqual({ id: 1, name: "row" });
    expect(buildStatementRan).toBe(false);
    expect(afterCommitIds).toEqual([1]);
  });

  test("skips afterCommit when the write returns no row", async () => {
    const table = makeTable();
    let afterCommitRan = false;

    const row = await writeWith(table, {
      afterCommit: () => {
        afterCommitRan = true;
        return Promise.resolve();
      },
      plainWrite: () => Promise.resolve(null),
      readBack: () => Promise.resolve(null),
      transactional: false,
    });

    expect(row).toBeNull();
    expect(afterCommitRan).toBe(false);
  });

  test("runs without an afterCommit hook", async () => {
    const table = makeTable();
    const row = await writeWith(table, {
      plainWrite: () => table.insert({ name: "Dave" }),
      readBack: reject("readBack"),
      transactional: false,
    });
    expect(row).toEqual({ id: 1, name: "Dave" });
  });
});
