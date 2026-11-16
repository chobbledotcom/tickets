import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { resultRows, type TxScope } from "#db/client.ts";
import {
  findRow,
  findRowPrimary,
  insertRow,
  insertRowStatement,
  updateRowStatement,
} from "#db/record-table.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { type EntityWrite, writeEntity } from "#shared/rest/write-entity.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";

type Row = { id: number; name: string };

const AGENTS = tables.logistics_agents;

/** The name of agent 1, read through the open transaction. */
const nameOfFirst = async (tx: TxScope): Promise<string | null> =>
  resultRows(await tx.execute(from(AGENTS).where({ id: 1 }).pick("name")))[0]
    ?.name ?? null;

const renameFirst = (name: string) => () =>
  updateRowStatement(AGENTS, 1, { name });

const reject = (what: string) => () =>
  Promise.reject(new Error(`${what} must not run`));

/** Call writeEntity with safe defaults, overriding only what a case exercises.
 *  The default write inserts one agent with no join write. */
const writeWith = <State = never>(
  overrides: Partial<EntityWrite<Row, State>>,
): Promise<Row | null> =>
  writeEntity<Row, State>({
    buildStatement: () => insertRowStatement(AGENTS, { name: "row" }),
    existingId: null,
    joinWrites: [],
    readBack: (id) => findRowPrimary(AGENTS, id),
    tableName: AGENTS.name,
    ...overrides,
  });

describe("writeEntity", () => {
  beforeEach(async () => {
    await createTestDb();
  });
  afterEach(() => resetDb());

  test("transactional path: writes the row, runs the join write in-tx, reads back on the primary", async () => {
    const joinIds: number[] = [];
    const afterCommitIds: number[] = [];

    const row = await writeWith<string>({
      afterCommit: (id) => {
        afterCommitIds.push(id);
        return Promise.resolve();
      },
      joinWrites: [
        (_tx, id, state) => {
          joinIds.push(id);
          expect(state).toBeNull();
          return Promise.resolve();
        },
      ],
      readState: reject("readState"),
    });

    expect(row).toEqual({ id: 1, name: "row" });
    // The join write saw the just-inserted row's id, inside the transaction.
    expect(joinIds).toEqual([1]);
    // afterCommit ran once with the written row's id, after the read-back.
    expect(afterCommitIds).toEqual([1]);
    expect(await findRow(AGENTS, 1)).toEqual({ id: 1, name: "row" });
  });

  test("runs every join write in order, all inside the one transaction", async () => {
    const order: string[] = [];
    const scopes: TxScope[] = [];

    await writeWith({
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
    });

    expect(order).toEqual(["first:1", "second:1"]);
    // Both join writes share the one transaction scope — not two separate ones.
    expect(scopes).toHaveLength(2);
    expect(scopes[0]).toBe(scopes[1]);
  });

  test("reads update state before the row write and passes it to every join write", async () => {
    await insertRow(AGENTS, { name: "before" });
    const events: string[] = [];
    const states: string[] = [];

    const row = await writeWith<string>({
      buildStatement: renameFirst("after"),
      existingId: 1,
      joinWrites: [
        async (tx, _id, state) => {
          states.push(String(state));
          events.push(`write:${await nameOfFirst(tx)}`);
        },
        (_tx, _id, state) => {
          states.push(String(state));
          events.push("second");
          return Promise.resolve();
        },
      ],
      readState: async (tx) => {
        const name = await nameOfFirst(tx);
        events.push(`read:${name}`);
        return name;
      },
    });

    expect(events).toEqual(["read:before", "write:after", "second"]);
    expect(states).toEqual(["before", "before"]);
    expect(row).toEqual({ id: 1, name: "after" });
  });

  test("passes null state without running a reader when none is configured", async () => {
    await insertRow(AGENTS, { name: "before" });
    const states: null[] = [];

    await writeWith({
      buildStatement: renameFirst("after"),
      existingId: 1,
      joinWrites: [
        (_tx, _id, state) => {
          states.push(state);
          return Promise.resolve();
        },
      ],
    });

    expect(states).toEqual([null]);
  });

  test("transactional path rolls the row back when a join write throws", async () => {
    let afterCommitRan = false;

    await expect(
      writeWith({
        afterCommit: () => {
          afterCommitRan = true;
          return Promise.resolve();
        },
        joinWrites: [() => Promise.reject(new Error("join failed"))],
      }),
    ).rejects.toThrow("join failed");

    // The row write rolled back with the failed join write; nothing persisted,
    // and the post-commit hook never ran.
    expect(await findRow(AGENTS, 1)).toBeNull();
    expect(afterCommitRan).toBe(false);
  });

  test("rolls an update back when a state-aware join write throws", async () => {
    await insertRow(AGENTS, { name: "before" });
    const seen: string[] = [];

    await expect(
      writeWith<string>({
        buildStatement: renameFirst("after"),
        existingId: 1,
        joinWrites: [
          (_tx, _id, state) => {
            seen.push(String(state));
            return Promise.reject(new Error("state rejected"));
          },
        ],
        readState: nameOfFirst,
      }),
    ).rejects.toThrow("state rejected");

    expect(seen).toEqual(["before"]);
    expect(await findRow(AGENTS, 1)).toEqual({ id: 1, name: "before" });
  });

  test("checkTx without join writes refuses before the row is written", async () => {
    const checkedIds: number[] = [];

    await expect(
      writeWith({
        checkTx: (_tx, id) => {
          checkedIds.push(id);
          return Promise.reject(new Error("no orphaning"));
        },
        existingId: 7,
      }),
    ).rejects.toThrow("no orphaning");

    expect(checkedIds).toEqual([7]);
    expect(await findRow(AGENTS, 1)).toBeNull();
  });

  test("a write with no join writes builds its statement and runs afterCommit", async () => {
    const afterCommitIds: number[] = [];

    const row = await writeWith({
      afterCommit: (id) => {
        afterCommitIds.push(id);
        return Promise.resolve();
      },
    });

    expect(row).toEqual({ id: 1, name: "row" });
    expect(afterCommitIds).toEqual([1]);
  });

  test("skips afterCommit when an update finds no row", async () => {
    let afterCommitRan = false;

    const row = await writeWith({
      afterCommit: () => {
        afterCommitRan = true;
        return Promise.resolve();
      },
      buildStatement: renameFirst("renamed"),
      existingId: 1,
    });

    expect(row).toBeNull();
    expect(afterCommitRan).toBe(false);
  });

  test("throws when a create cannot read its own inserted row back", async () => {
    await expect(
      writeWith({
        existingId: null,
        joinWrites: [() => Promise.resolve()],
        readBack: () => Promise.resolve(null),
      }),
    ).rejects.toThrow(
      "logistics_agents: row 1 was inserted but could not be read back",
    );
  });

  test("returns null when an update's row is gone by the time it reads back", async () => {
    await insertRow(AGENTS, { name: "row" });

    const row = await writeWith({
      buildStatement: renameFirst("renamed"),
      existingId: 1,
      joinWrites: [() => Promise.resolve()],
      readBack: () => Promise.resolve(null),
    });

    expect(row).toBeNull();
  });

  test("an update of a deleted row runs no join write and returns null", async () => {
    const joinIds: number[] = [];

    const row = await writeWith({
      buildStatement: renameFirst("renamed"),
      existingId: 1,
      joinWrites: [
        (_tx, id) => {
          joinIds.push(id);
          return Promise.resolve();
        },
      ],
      readBack: reject("readBack"),
    });

    expect(row).toBeNull();
    expect(joinIds).toEqual([]);
  });

  test("runs without an afterCommit hook", async () => {
    const row = await writeWith({
      buildStatement: () => insertRowStatement(AGENTS, { name: "Dave" }),
    });
    expect(row).toEqual({ id: 1, name: "Dave" });
  });
});
