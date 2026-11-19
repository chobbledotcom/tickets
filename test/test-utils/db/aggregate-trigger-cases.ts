import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { type SqlSlot, sql, sqlName, sqlNames, sqlRows } from "#db/sql.ts";

/** A parent row's trigger-maintained count columns, by name. */
export type AggregateCounts = Readonly<Record<string, number>>;

/** One counted row: the attendee id and the quantity to store. */
export type AggregateSeedRow = readonly [attendeeId: number, quantity: number];

/** The rows that a set of aggregate triggers counts. */
export type AggregateRows = {
  /** The counted table, e.g. listing_attendees. */
  table: string;
  /** The column that points at the counted parent, e.g. listing_id. */
  parent: string;
  /** Columns every seeded row also holds, because the table declares no
   * default for them. */
  values?: Readonly<Record<string, SqlSlot>>;
};

/** The raw writes that fire the triggers on one counted table. */
export type AggregateRowWrites = {
  /** Write one column on one counted row. */
  set: (
    parentId: number,
    attendeeId: number,
    column: string,
    value: SqlSlot,
  ) => Promise<unknown>;
  /** Delete one counted row. */
  remove: (parentId: number, attendeeId: number) => Promise<unknown>;
  /** Move one counted row to another parent. */
  move: (
    fromParentId: number,
    attendeeId: number,
    toParentId: number,
  ) => Promise<unknown>;
};

/** The rows a parent's seeds and writes address: one parent and one attendee. */
const rowWhere = (
  rows: AggregateRows,
  parentId: number,
  attendeeId: number,
): SqlSlot =>
  sql`${sqlName(rows.parent)} = ${parentId} AND attendee_id = ${attendeeId}`;

/**
 * Seed counted rows for one parent through the raw client. The writes reach the
 * trigger SQL directly, so they exercise the branch a booking flow skips.
 */
export const seedAggregateRows = (
  rows: AggregateRows,
  parentId: number,
  seed: readonly AggregateSeedRow[],
): Promise<unknown> => {
  const extra = rows.values ?? {};
  if (seed.length === 0) return Promise.resolve();
  const columns = [
    rows.parent,
    "attendee_id",
    "quantity",
    ...Object.keys(extra),
  ];
  const values = seed.map(([attendeeId, quantity]) => [
    parentId,
    attendeeId,
    quantity,
    ...Object.values(extra),
  ]);
  return getDb().execute(
    sql`INSERT INTO ${sqlName(rows.table)} (${sqlNames(columns)}) VALUES ${sqlRows(values)}`,
  );
};

const rowWrites = (rows: AggregateRows): AggregateRowWrites => ({
  move: (fromParentId, attendeeId, toParentId) =>
    getDb().execute(
      sql`UPDATE ${sqlName(rows.table)} SET ${sqlName(
        rows.parent,
      )} = ${toParentId} WHERE ${rowWhere(rows, fromParentId, attendeeId)}`,
    ),
  remove: (parentId, attendeeId) =>
    getDb().execute(
      sql`DELETE FROM ${sqlName(rows.table)} WHERE ${rowWhere(
        rows,
        parentId,
        attendeeId,
      )}`,
    ),
  set: (parentId, attendeeId, column, value) =>
    getDb().execute(
      sql`UPDATE ${sqlName(rows.table)} SET ${sqlName(
        column,
      )} = ${value} WHERE ${rowWhere(rows, parentId, attendeeId)}`,
    ),
});

/** One raw write and the counts it must leave on the parent. */
export type AggregateStep = {
  /** Raw write that fires the triggers; omit to check the seeded state. */
  write?: (writes: AggregateRowWrites, parentId: number) => Promise<unknown>;
  expected: AggregateCounts;
};

/** A run of raw writes on one parent, with the counts after each write. */
export type AggregateStepsCase = {
  name: string;
  /** Rows seeded before the first write. */
  seed: readonly AggregateSeedRow[];
  steps: readonly AggregateStep[];
};

/** A move of one seeded row to a second parent, with the counts both keep. */
export type AggregateMoveCase = {
  name: string;
  /** The row to move: attendee id and quantity. */
  row: AggregateSeedRow;
  /** Counts the row's old parent must hold after the move. */
  from: AggregateCounts;
  /** Counts the new parent must hold after the move. */
  to: AggregateCounts;
};

export type AggregateTriggerCase = AggregateStepsCase | AggregateMoveCase;

/** A parent whose counts a case checks, and how to read those counts. */
export type AggregateTriggerFixture = {
  /** Create one parent row. */
  createParent: () => Promise<{ id: number }>;
  /** Read a parent's stored count columns. */
  readCounts: (parentId: number) => Promise<AggregateCounts>;
  rows: AggregateRows;
};

/**
 * Run each case as its own test. A case seeds raw rows, applies each raw write,
 * then checks every stored count column by value, so a trigger that drifts by
 * one fails.
 */
export const describeAggregateTriggerCases = (
  fixture: AggregateTriggerFixture,
  cases: readonly AggregateTriggerCase[],
): void => {
  const writes = rowWrites(fixture.rows);
  for (const item of cases) {
    if ("row" in item) {
      test(item.name, async () => {
        const from = await fixture.createParent();
        const to = await fixture.createParent();
        await seedAggregateRows(fixture.rows, from.id, [item.row]);
        await writes.move(from.id, item.row[0], to.id);
        expect(await fixture.readCounts(from.id)).toEqual(item.from);
        expect(await fixture.readCounts(to.id)).toEqual(item.to);
      });
      continue;
    }
    test(item.name, async () => {
      const parent = await fixture.createParent();
      await seedAggregateRows(fixture.rows, parent.id, item.seed);
      for (const step of item.steps) {
        if (step.write) await step.write(writes, parent.id);
        expect(await fixture.readCounts(parent.id)).toEqual(step.expected);
      }
    });
  }
};

/** The cases every counted table shares, keyed by the behaviour they check. */
export type SharedAggregateCases = Record<
  | "zeroStart"
  | "insert"
  | "delete"
  | "updateQuantity"
  | "unrelatedColumn"
  | "moveToOtherParent",
  AggregateTriggerCase
>;

/** What each counted table supplies to the shared cases. */
export type SharedAggregateConfig = {
  /** Noun the parent carries in test names, e.g. listing. */
  parent: string;
  /** Test name for the insert case; each table words its units differently. */
  insert: string;
  /** A column that no aggregate trigger watches. */
  unrelatedColumn: string;
  /** The table's two count columns, from the summed quantity and row count. */
  counts: (quantity: number, rows: number) => AggregateCounts;
};

/**
 * The trigger cases that both counted tables must pass: a zeroed start, insert,
 * delete, quantity update, unrelated-column write, and a move between parents.
 * The cases live here once because the trigger SQL has the same shape for both
 * tables.
 */
export const sharedAggregateTriggerCases = (
  config: SharedAggregateConfig,
): SharedAggregateCases => {
  const { counts } = config;

  /** One write to a column of the counted row, and the counts it must leave. */
  const columnWrite = (
    name: string,
    column: string,
    value: number,
    expected: AggregateCounts,
  ): AggregateStepsCase => ({
    name,
    seed: [[1, 3]],
    steps: [
      {
        expected,
        write: (writes, parentId) => writes.set(parentId, 1, column, value),
      },
    ],
  });

  return {
    delete: {
      name: "delete decrements the row's contribution",
      seed: [
        [1, 3],
        [2, 2],
      ],
      steps: [
        {
          expected: counts(2, 1),
          write: (writes, parentId) => writes.remove(parentId, 1),
        },
      ],
    },
    insert: {
      name: config.insert,
      seed: [
        [1, 3],
        [2, 2],
      ],
      steps: [{ expected: counts(5, 2) }],
    },
    moveToOtherParent: {
      from: counts(0, 0),
      name: `moving a row to another ${config.parent} shifts its aggregates`,
      row: [1, 4],
      to: counts(4, 1),
    },
    unrelatedColumn: columnWrite(
      "updating an unrelated column leaves aggregates unchanged",
      config.unrelatedColumn,
      1,
      counts(3, 1),
    ),
    updateQuantity: columnWrite(
      "updating quantity applies the delta",
      "quantity",
      5,
      counts(5, 1),
    ),
    zeroStart: {
      name: `a new ${config.parent} starts with zeroed aggregates`,
      seed: [],
      steps: [{ expected: counts(0, 0) }],
    },
  };
};
