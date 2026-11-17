/**
 * The one write path every admin record shares: the rule runs first, the row,
 * its joins, its order append, and its activity line commit together, and a
 * refusal writes nothing.
 *
 * The HTTP contract for each record (list, read, create, update, delete, and
 * the role answers) stays with that record's own suites and the parity pins.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getDb } from "#db/client.ts";
import { readRows } from "#db/read.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { TransactionValidationError } from "#db/transaction.ts";
import {
  defineRecord,
  type RecordShapeOf,
  type RecordSpec,
  type WritePlan,
} from "#shared/rest/record.ts";
import { errorResult, okResult } from "#shared/result.ts";
import {
  getAllActivityLog,
  wasActivityLogged,
} from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import type { IdNameInput, IdNameRow } from "#test-utils/rest-fixtures.ts";

const table = tables.logistics_agents;

const widgetRecord = (
  overrides: Partial<RecordSpec<RecordShapeOf<IdNameRow, IdNameInput>>> = {},
) =>
  defineRecord<RecordShapeOf<IdNameRow, IdNameInput>>()({
    activityName: "Widget",
    getAll: () => storedWidgets(),
    logName: (input) => input.name,
    nameOf: (row) => row.name,
    rule: (input) =>
      input.name === ""
        ? errorResult("A widget needs a name")
        : okResult(input),
    surface: "holidays",
    table,
    ...overrides,
  });

const storedWidgets = (): Promise<IdNameRow[]> =>
  readRows(from(table).sortedBy("id").everyColumn());

const createWidget = async (
  name: string,
  record = widgetRecord(),
): Promise<IdNameRow> => {
  const created = await record.create({ name });
  if (created.kind !== "written") throw new Error("create failed");
  return created.row;
};

describeWithEnv("the admin record write path", { db: true }, () => {
  test("create writes the row and its activity line", async () => {
    const created = await createWidget("Alpha");

    expect(created).toEqual({ id: 1, name: "Alpha" });
    expect(await wasActivityLogged("Widget 'Alpha' created")).toBe(true);
  });

  test("a record with no rule stores its input unchanged", async () => {
    const { rule: _rule, ...ruleless } = widgetRecord();
    const record =
      defineRecord<RecordShapeOf<IdNameRow, IdNameInput>>()(ruleless);

    expect(await record.create({ name: "" })).toEqual({
      kind: "written",
      row: { id: 1, name: "" },
    });
  });

  test("a refused rule writes no row and no activity line", async () => {
    const verdict = await widgetRecord().create({ name: "" });

    expect(verdict).toEqual({
      kind: "refused",
      message: "A widget needs a name",
    });
    expect(await storedWidgets()).toEqual([]);
    expect(await wasActivityLogged("Widget '' created")).toBe(false);
  });

  test("update hands the stored row to the rule and stores its answer", async () => {
    const created = await createWidget("Old");
    const record = widgetRecord({
      rule: (input, stored) =>
        okResult({
          name: stored?.name === "Old" ? `${input.name}!` : input.name,
        }),
    });

    const updated = await record.update(created.id, { name: "New" });

    expect(updated).toMatchObject({ kind: "written" });
    expect(await storedWidgets()).toEqual([{ id: 1, name: "New!" }]);
    expect(await wasActivityLogged("Widget 'New!' updated")).toBe(true);
  });

  test("an update of a missing row answers not-found", async () => {
    const verdict = await widgetRecord().update(999, { name: "Gone" });

    expect(verdict).toEqual({ kind: "not-found" });
    expect(await storedWidgets()).toEqual([]);
  });

  test("a delete refusal keeps the row and logs nothing", async () => {
    const created = await createWidget("Keep");
    const record = widgetRecord({
      deleteRefusal: () => Promise.resolve("Cannot delete this one"),
    });

    const verdict = await record.remove(created.id);

    expect(verdict).toEqual({
      kind: "refused",
      message: "Cannot delete this one",
    });
    expect(await storedWidgets()).toEqual([{ id: 1, name: "Keep" }]);
    expect(await wasActivityLogged("Widget 'Keep' deleted")).toBe(false);
  });

  test("delete removes the row and writes its activity line", async () => {
    const created = await createWidget("Bye");
    const record = widgetRecord();

    expect(await record.remove(created.id)).toEqual({ kind: "deleted" });
    expect(await storedWidgets()).toEqual([]);
    expect(await wasActivityLogged("Widget 'Bye' deleted")).toBe(true);
    expect(await record.remove(created.id)).toEqual({ kind: "not-found" });
  });

  test("a write with no join steps stores the row", async () => {
    const record = widgetRecord({ logAfterCommit: true });

    const created = await createWidget("Plain", record);
    expect(created).toEqual({ id: 1, name: "Plain" });

    const updated = await record.update(created.id, { name: "Plainer" });
    expect(updated).toEqual({
      kind: "written",
      row: { id: 1, name: "Plainer" },
    });
    expect(await storedWidgets()).toEqual([{ id: 1, name: "Plainer" }]);
  });

  test("a linked write names its row on every activity line", async () => {
    const record = widgetRecord({ linkActivityToRow: true });

    expect(await createWidget("Linked", record)).toEqual({
      id: 1,
      name: "Linked",
    });
    expect(
      (await getAllActivityLog()).map((entry) => [
        entry.listingId,
        entry.message,
      ]),
    ).toEqual([[1, "Widget 'Linked' created"]]);

    expect(await record.remove(1)).toEqual({ kind: "deleted" });
    expect(
      (await getAllActivityLog()).map((entry) => [
        entry.listingId,
        entry.message,
      ]),
    ).toEqual([
      [1, "Widget 'Linked' deleted"],
      [1, "Widget 'Linked' created"],
    ]);
  });

  test("a table record loads through the replica and the primary", async () => {
    const created = await createWidget("Defaults");
    const record = widgetRecord();

    expect(await record.load(created.id)).toEqual(created);
    expect(await record.loadAfterWrite(created.id)).toEqual(created);
    expect(await record.load(999)).toBeNull();
  });

  test("a table record reads a page from the replica and a write from the primary", async () => {
    const record = widgetRecord();
    await createWidget("Spied", record);
    const reads: string[] = [];
    const db = getDb();
    const realExecute = db.execute.bind(db);
    const realBatch = db.batch.bind(db);
    using _execute = stub(db, "execute", (...args) => {
      reads.push("replica");
      return realExecute(...(args as Parameters<typeof realExecute>));
    });
    using _batch = stub(db, "batch", (...args) => {
      reads.push(args[1] === "write" ? "primary" : "replica");
      return realBatch(...(args as Parameters<typeof realBatch>));
    });

    await record.load(1);
    await record.loadAfterWrite(1);
    reads.push("update");
    await record.update(1, { name: "Moved" });

    expect(reads.slice(0, 3)).toEqual(["replica", "primary", "update"]);
    expect(reads.at(-1)).toBe("primary");
  });

  test("a join write sees the written id and the ruled input", async () => {
    const joined: [number, string, unknown][] = [];
    const record = widgetRecord({
      afterWrite: (_tx, id, input, state) => {
        joined.push([id, input.name, state]);
        return Promise.resolve();
      },
      rule: (input) => okResult({ name: `${input.name}!` }),
    });

    await createWidget("Joined", record);

    expect(joined).toEqual([[1, "Joined!", null]]);
  });

  test("a write logged after commit names its row only when linked", async () => {
    const logLines = async () =>
      (await getAllActivityLog()).map((entry) => [
        entry.listingId,
        entry.message,
      ]);
    const linked = widgetRecord({
      linkActivityToRow: true,
      logAfterCommit: true,
    });
    await createWidget("Late", linked);
    await linked.update(1, { name: "Later" });
    await createWidget("Loose", widgetRecord({ logAfterCommit: true }));

    expect(await logLines()).toEqual([
      [null, "Widget 'Loose' created"],
      [1, "Widget 'Later' updated"],
      [1, "Widget 'Late' created"],
    ]);
  });

  test("a refused write logged after commit logs nothing", async () => {
    const record = widgetRecord({
      logAfterCommit: true,
      order: {
        append: () => {
          throw new TransactionValidationError("Order failed");
        },
      },
    });

    expect(await record.create({ name: "Unlogged" })).toEqual({
      kind: "refused",
      message: "Order failed",
    });
    expect(await getAllActivityLog()).toEqual([]);
  });

  const refusedPlans: [string, WritePlan<undefined>, string][] = [
    [
      "a plan refusal writes nothing",
      { prepare: () => Promise.resolve({ error: "No side data" }) },
      "No side data",
    ],
    [
      "a failed join write rolls the row and the log back",
      {
        persist: () => {
          throw new TransactionValidationError("Join failed");
        },
      },
      "Join failed",
    ],
  ];
  for (const [title, plan, message] of refusedPlans) {
    test(title, async () => {
      const verdict = await widgetRecord().create({ name: "Planned" }, plan);

      expect(verdict).toEqual({ kind: "refused", message });
      expect(await storedWidgets()).toEqual([]);
      expect(await getAllActivityLog()).toEqual([]);
    });
  }

  test("a failed order append rolls the row back", async () => {
    const record = widgetRecord({
      order: {
        append: () => {
          throw new TransactionValidationError("Order failed");
        },
      },
    });

    const verdict = await record.create({ name: "Unordered" });

    expect(verdict).toEqual({ kind: "refused", message: "Order failed" });
    expect(await storedWidgets()).toEqual([]);
  });

  test("only a create appends the row to its order, so an update keeps its place", async () => {
    const appended: unknown[] = [];
    const record = widgetRecord({
      order: {
        append: ({ key }) => {
          appended.push(key);
          return Promise.resolve();
        },
      },
    });
    await createWidget("First", record);
    await createWidget("Second", record);

    expect(await record.update(1, { name: "Renamed" })).toEqual({
      kind: "written",
      row: { id: 1, name: "Renamed" },
    });
    expect(appended).toEqual([1, 2]);
  });
});

describe("the record read defaults", () => {
  type Widget = RecordShapeOf<IdNameRow, IdNameInput>;
  const bareRecord = (spec: Partial<RecordSpec<Widget>> = {}) =>
    defineRecord<Widget>()({
      activityName: "Widget",
      logName: (input) => input.name,
      nameOf: (row) => row.name,
      rule: (input) => okResult(input),
      surface: "holidays",
      ...spec,
    });

  test("a record with no declared read refuses the read it cannot serve", () => {
    const record = bareRecord();

    expect(() => record.getAll()).toThrow(
      "The record for holidays declares no collection read",
    );
    expect(() => record.load(1)).toThrow(
      "The record for holidays declares no load read",
    );
  });

  test("a read bundle serves both reads and the write read-back", async () => {
    const row: IdNameRow = { id: 3, name: "Bundled" };
    const record = bareRecord({
      reads: {
        all: () => Promise.resolve([row]),
        one: () => Promise.resolve(row),
      },
    });

    expect(await record.getAll()).toEqual([row]);
    expect(await record.load(3)).toEqual(row);
    expect(await record.loadAfterWrite(3)).toEqual(row);
  });

  const tablelessReads: [string, Partial<RecordSpec<Widget>>][] = [
    [
      "a record with no table refuses every generated write",
      {
        getAll: () => Promise.resolve([]),
        load: (id) =>
          Promise.resolve(id === 1 ? { id: 1, name: "Loaded" } : null),
      },
    ],
    [
      "a record with no table finds a write's row through its read-back",
      {
        load: () => Promise.resolve(null),
        loadAfterWrite: (id) =>
          Promise.resolve(id === 1 ? { id: 1, name: "Committed" } : null),
      },
    ],
  ];
  for (const [title, reads] of tablelessReads) {
    test(title, async () => {
      const record = bareRecord(reads);

      expect(() => record.create({ name: "Orphan" })).toThrow(
        "The record for holidays declares no table",
      );
      await expect(record.update(1, { name: "Orphan" })).rejects.toThrow(
        "The record for holidays declares no table",
      );
      expect(await record.remove(2)).toEqual({ kind: "not-found" });
    });
  }

  test("refuses a write whose input check answers", async () => {
    const record = bareRecord({
      inputCheck: (input) =>
        input.name === "Rejected" ? "Name is refused" : null,
    });

    expect(await record.create({ name: "Rejected" })).toEqual({
      kind: "refused",
      message: "Name is refused",
    });
    expect(await record.update(1, { name: "Rejected" })).toEqual({
      kind: "refused",
      message: "Name is refused",
    });
  });

  test("refuses a write when the input check answers an empty message", async () => {
    const record = bareRecord({ inputCheck: () => "" });

    expect(await record.create({ name: "Rejected" })).toEqual({
      kind: "refused",
      message: "",
    });
  });
});
