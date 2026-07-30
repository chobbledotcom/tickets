import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import type { TxScope } from "#shared/db/client.ts";
import type { Table } from "#shared/db/table.ts";
import { type EntityWrite, writeEntity } from "#shared/rest/write-entity.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";
import {
  createIdNameTable,
  type IdNameInput as Input,
  makeIdNameTable,
  type IdNameRow as Row,
} from "#test-utils/rest-fixtures.ts";

const makeTable = (): Table<Row, Input> => makeIdNameTable("we_items");
const createTable = (): Promise<void> => createIdNameTable("we_items");

const reject = (what: string) => () =>
  Promise.reject(new Error(`${what} must not run`));

/** Call writeEntity with safe defaults, overriding only what a case exercises.
 *  Defaults to the plain path (no join writes). */
const writeWith = (
  table: Table<Row, Input>,
  overrides: Partial<EntityWrite<Row>>,
): Promise<Row | null> =>
  writeEntity<Row>({
    buildStatement: () => table.insertStatement!({ name: "row" }),
    existingId: null,
    joinWrites: [],
    plainWrite: () => table.insert({ name: "row" }),
    readBack: (id) => table.findByIdPrimary!(id),
    tableName: "we_items",
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
      joinWrites: [
        (_tx, id) => {
          joinIds.push(id);
          return Promise.resolve();
        },
      ],
      plainWrite: reject("plainWrite"),
    });

    expect(row).toEqual({ id: 1, name: "row" });
    // The join write saw the just-inserted row's id, inside the transaction.
    expect(joinIds).toEqual([1]);
    // afterCommit ran once with the written row's id, after the read-back.
    expect(afterCommitIds).toEqual([1]);
    expect(await table.findById(1)).toEqual({ id: 1, name: "row" });
  });

  test("runs every join write in order, all inside the one transaction", async () => {
    const table = makeTable();
    const order: string[] = [];
    const scopes: TxScope[] = [];

    await writeWith(table, {
      joinWrites: [
        (tx, id) => {
          scopes.push(tx);
          order.push(`first:${id}`);
          return Promise.resolve();
        },
        (tx, id) => {
          scopes.push(tx);
          order.push(`second:${id}`);
          return Promise.resolve();
        },
      ],
      plainWrite: reject("plainWrite"),
    });

    expect(order).toEqual(["first:1", "second:1"]);
    // Both join writes share the one transaction scope — not two separate ones.
    expect(scopes).toHaveLength(2);
    expect(scopes[0]).toBe(scopes[1]);
  });

  test("transactional path rolls the row back when a join write throws", async () => {
    const table = makeTable();
    let afterCommitRan = false;

    await expect(
      writeWith(table, {
        afterCommit: () => {
          afterCommitRan = true;
          return Promise.resolve();
        },
        joinWrites: [() => Promise.reject(new Error("join failed"))],
        plainWrite: reject("plainWrite"),
      }),
    ).rejects.toThrow("join failed");

    // The row write rolled back with the failed join write; nothing persisted,
    // and the post-commit hook never ran.
    expect(await table.findById(1)).toBeNull();
    expect(afterCommitRan).toBe(false);
  });

  test("plain path (no join writes): uses plainWrite, skips the statement, still runs afterCommit", async () => {
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
      readBack: reject("readBack"),
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
    });

    expect(row).toBeNull();
    expect(afterCommitRan).toBe(false);
  });

  test("throws when a create can't read its own inserted row back", async () => {
    const table = makeTable();

    await expect(
      writeWith(table, {
        existingId: null,
        joinWrites: [() => Promise.resolve()],
        plainWrite: reject("plainWrite"),
        readBack: () => Promise.resolve(null),
      }),
    ).rejects.toThrow(
      "we_items: row 1 was inserted but could not be read back",
    );
  });

  test("returns null when an update's row is gone by the time it reads back", async () => {
    const table = makeTable();
    await table.insert({ name: "row" });

    const row = await writeWith(table, {
      buildStatement: () => table.updateStatement!(1, { name: "renamed" }),
      existingId: 1,
      joinWrites: [() => Promise.resolve()],
      plainWrite: reject("plainWrite"),
      readBack: () => Promise.resolve(null),
    });

    expect(row).toBeNull();
  });

  test("runs without an afterCommit hook", async () => {
    const table = makeTable();
    const row = await writeWith(table, {
      plainWrite: () => table.insert({ name: "Dave" }),
      readBack: reject("readBack"),
    });
    expect(row).toEqual({ id: 1, name: "Dave" });
  });
});
