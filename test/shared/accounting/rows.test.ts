import { assert, assertArrayIncludes, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  bookingLegBatchInsert,
  byColumnIn,
  insertStatement,
  selectByEventGroup,
  selectById,
  selectTransfers,
  selectTransfersMany,
} from "#accounting/rows.ts";
import {
  type BatchExecutor,
  executeBatch,
  queryBatch,
  queryOne,
  resultsOf,
  type TxScope,
  withTransaction,
} from "#db/client.ts";
import { type SqlStatement, sql } from "#db/sql.ts";
import { account } from "#shared/ledger/account.ts";
import type { Transfer, TransferInput } from "#shared/ledger/types.ts";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";
import { useTransactionalDb } from "#test-utils/ledger.ts";
import { placed } from "#test-utils/sql-text.ts";

/** The value bound to `column` in a built INSERT, by pairing the SQL's leading
 *  column list with its positional args. */
const boundValue = (
  statement: { sql: string; args: readonly unknown[] },
  column: string,
): unknown => {
  const columns = statement.sql
    .slice(statement.sql.indexOf("(") + 1, statement.sql.indexOf(")"))
    .split(",")
    .map((name) => name.trim());
  return placed(statement).args[columns.indexOf(column)];
};

/** A transfer for the stored-row cases. `overrides` carries the fields a case
 *  varies: a distinct id pair makes a swapped source and destination visible,
 *  and the reference and event group name the leg. */
const transferLeg = (
  overrides: Partial<TransferInput> = {},
): TransferInput => ({
  amount: 5000,
  destination: account("revenue", 7),
  eventGroup: "evt",
  occurredAt: "2026-06-21T00:00:00.000Z",
  reference: "ref",
  source: account("attendee", 3),
  ...overrides,
});

/** A leg whose event group and reference both carry `name`, so a reader that
 *  returns the wrong leg is visible. */
const namedLeg = (
  name: string,
  overrides: Partial<TransferInput> = {},
): TransferInput =>
  transferLeg({
    eventGroup: `evt-${name}`,
    reference: `ref-${name}`,
    ...overrides,
  });

describe("accounting > rows > insertStatement", () => {
  const base = transferLeg({
    destination: account("revenue", 1),
    source: account("attendee", 1),
  });
  const recordedAt = "2026-06-21T12:00:00.000Z";

  test("defaults posted_by and reverses_id only when absent, preserving explicit edge values", () => {
    // `?? "system"` / `?? null` default solely on undefined, so an explicit ""
    // actor and a 0 reverses_id are kept — a `|| "system"` / `|| null` would
    // wrongly replace the empty string and the zero.
    const explicit = insertStatement(
      { ...base, postedBy: "", reversesId: 0 },
      recordedAt,
    );
    expect(boundValue(explicit, "posted_by")).toBe("");
    expect(boundValue(explicit, "reverses_id")).toBe(0);

    const absent = insertStatement(base, recordedAt);
    expect(boundValue(absent, "posted_by")).toBe("system");
    expect(boundValue(absent, "reverses_id")).toBe(null);
  });
});

describe("accounting > rows > bookingLegBatchInsert", () => {
  const recordedAt = "2026-06-21T12:00:00.000Z";
  // Distinct attendee (3) and revenue (9) ids, so a swapped side is visible:
  // the attendee literal must vanish (replaced by the subquery) while the
  // revenue literal stays bound.
  const leg = transferLeg({
    destination: account("revenue", 9),
    kind: "sale",
  });
  const guard = sql`${"g"} = 'g'`;

  test("renders ONLY the attendee side via the in-batch id subquery", () => {
    const built = bookingLegBatchInsert(
      leg,
      recordedAt,
      sql`MAX(id) + ${7}`,
      guard,
    );
    // source is the attendee account -> subquery; destination (revenue) stays a
    // bound literal. Swapping the two would post the sale to a phantom account.
    const text = placed(built).sql;
    assertStringIncludes(text, "CAST(MAX(id) + ?");
    expect(text.indexOf("CAST(MAX(id) + ?")).toBe(
      text.lastIndexOf("CAST(MAX(id) + ?"),
    );
    assertArrayIncludes(built.args, [7]); // the subquery's bound arg
    assertArrayIncludes(built.args, ["9"]); // revenue id still a bound literal
    assert(!built.args.includes("3")); // attendee id replaced by subquery
    expect(built.args.at(-1)).toBe("g"); // guard args come last
    expect(built.sql).toMatch(/^INSERT OR IGNORE INTO transfers /);
    expect(built.sql).toMatch(/WHERE \?\d+ = 'g'$/);
  });
});

/** A reader that answers nothing but remembers what it was handed. */
const recordingReader = (): {
  asked: SqlStatement[][];
  reader: BatchExecutor;
} => {
  const asked: SqlStatement[][] = [];
  const reader: BatchExecutor = (statements) => {
    asked.push([...statements]);
    return Promise.resolve(resultsOf(statements.map(() => emptyResultSet())));
  };
  return { asked, reader };
};

const STORED_AT = "2026-06-21T12:00:00.000Z";

/** Two legs under different events, so a reader that ignores its filter and
 *  returns everything is visible. */
const storeTwoLegs = (): Promise<void> =>
  executeBatch([
    insertStatement(namedLeg("a"), STORED_AT),
    insertStatement(namedLeg("b"), STORED_AT),
  ]);

/** The id a reference was stored under, read straight from the table: a test of
 *  one reader must not lean on another to set itself up. */
const storedIdFor = async (reference: string): Promise<number> => {
  const row = await queryOne<{ id: number | bigint }>(
    sql`SELECT id FROM transfers WHERE reference = ${reference}`,
  );
  if (row === null) throw new Error(`Nothing was stored for ${reference}`);
  return Number(row.id);
};

describe("accounting > rows > selectTransfersMany", () => {
  useTransactionalDb();

  test("gives each set of rows back to the query that asked for it", async () => {
    await storeTwoLegs();

    const [byGroup, byReference] = await selectTransfersMany(queryBatch, [
      byColumnIn("eventGroup", ["evt-b"]),
      byColumnIn("reference", ["ref-a"]),
    ]);

    // Swapped answers would read as a stored collision that is not there.
    expect(byGroup.map((row) => row.reference)).toEqual(["ref-b"]);
    expect(byReference.map((row) => row.reference)).toEqual(["ref-a"]);
  });

  test("answers a query nothing can match without asking for it", async () => {
    const { asked, reader } = recordingReader();

    const [none, some] = await selectTransfersMany(reader, [
      byColumnIn("id", []),
      byColumnIn("reference", ["ref-a"]),
    ]);

    expect(none).toEqual([]);
    expect(some).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.map((statement) => statement.args)).toEqual([["ref-a"]]);
  });

  test("asks for nothing at all when no query can match", async () => {
    const { asked, reader } = recordingReader();

    const rows = await selectTransfersMany(reader, [
      byColumnIn("id", []),
      byColumnIn("reference", []),
    ]);

    expect(rows).toEqual([[], []]);
    expect(asked).toEqual([]);
  });

  test("asks an open transaction once, not once per query", async () => {
    await storeTwoLegs();
    let batches = 0;
    let singles = 0;

    const rows = await withTransaction((scope) => {
      const counted: TxScope = {
        batch: (statements) => {
          batches += 1;
          return scope.batch(statements);
        },
        execute: (statement: SqlStatement) => {
          singles += 1;
          return scope.execute(statement);
        },
      };
      return selectTransfersMany(counted.batch, [
        byColumnIn("eventGroup", ["evt-a"]),
        byColumnIn("reference", ["ref-b"]),
      ]);
    });

    expect(batches).toBe(1);
    expect(singles).toBe(0);
    expect(rows.map((set) => set.map((row) => row.reference))).toEqual([
      ["ref-a"],
      ["ref-b"],
    ]);
  });
});

describe("accounting > rows > readers for one event and one row", () => {
  useTransactionalDb();

  test("selectByEventGroup reads that event's legs and not its neighbour's", async () => {
    await storeTwoLegs();

    const legs = await selectByEventGroup(queryBatch, "evt-a");

    expect(legs.map((row) => row.reference)).toEqual(["ref-a"]);
  });

  test("selectById reads the transfer stored under that id", async () => {
    await storeTwoLegs();
    const id = await storedIdFor("ref-b");

    const found = await selectById(queryBatch, id);

    expect(found?.id).toBe(id);
    expect(found?.reference).toBe("ref-b");
  });

  test("selectById answers null when no transfer has that id", async () => {
    await storeTwoLegs();

    expect(await selectById(queryBatch, 999_999)).toBeNull();
  });
});

describe("accounting > rows > stored-row round-trip", () => {
  useTransactionalDb();
  const recordedAt = "2026-06-21T12:00:00.000Z";

  /** Store one leg and read it straight back — the round trip each single-field
   *  reader case checks. */
  const roundTripLeg = async (
    name: string,
    overrides: Partial<TransferInput> = {},
  ): Promise<Transfer> => {
    await executeBatch([
      insertStatement(namedLeg(name, overrides), recordedAt),
    ]);
    const [stored] = await selectTransfers(queryBatch);
    if (stored === undefined) throw new Error(`the ${name} leg did not store`);
    return stored;
  };

  /** Store the legs, then read the ledger back in the order of storage. */
  const storedInOrder = async (
    legs: readonly TransferInput[],
  ): Promise<Transfer[]> => {
    await executeBatch(legs.map((leg) => insertStatement(leg, recordedAt)));
    return selectTransfers(queryBatch, (ledger) =>
      ledger.orderBy((leg) => [leg.id]),
    );
  };

  test("selectTransfers reads every column back, reversesId present and absent", async () => {
    const plain = namedLeg("plain", { kind: "sale", memo: "first" });
    // A void leg carrying a (non-FK) reverses_id, so the NULL vs real-id branch of
    // the row→Transfer mapping is exercised both ways.
    const voiding: TransferInput = {
      ...plain,
      eventGroup: "evt-void",
      kind: "void",
      reference: "ref-void",
      reversesId: 999,
    };
    const all = await storedInOrder([plain, voiding]);
    expect(all.length).toBe(2);
    const [first, second] = all;

    // Full-fidelity round-trip — a corrupted SELECT column list loses these.
    expect(first).toMatchObject({
      amount: 5000,
      destination: account("revenue", 7),
      eventGroup: "evt-plain",
      kind: "sale",
      memo: "first",
      occurredAt: "2026-06-21T00:00:00.000Z",
      reference: "ref-plain",
      source: account("attendee", 3),
    });

    // NULL reverses_id maps to undefined; a real id maps to the Number.
    expect(first!.reversesId).toBe(undefined);
    expect(second!.reversesId).toBe(999);
  });

  test("a kindless leg stores as '' and reads back with kind omitted", async () => {
    const stored = await roundTripLeg("kindless", { amount: 100 });
    // Omitted, not "": a stored transfer and a never-stored input must agree
    // on what "no kind" looks like (mirroring reverses_id).
    expect("kind" in stored).toBe(false);
  });

  test("a leg with no memo stores an empty one, not a stand-in", async () => {
    const stored = await roundTripLeg("memoless", { amount: 100 });
    // Unlike kind, memo keeps its "" — so the absence must be stored as empty
    // rather than as any filler a reader would later show to an operator.
    expect(stored.memo).toBe("");
  });

  test("a reversal leg reads back naming its order; a plain leg carries no mark", async () => {
    // A refund leg and a plain leg of the same order: the round-trip must
    // return the reversed order's group on the refund leg and omit the field
    // for a leg with none, mirroring `reverses_id`'s NULL-vs-id mapping.
    const refund = namedLeg("refund", {
      destination: account("attendee", 3),
      kind: "refund_sale",
      reversesGroup: "evt-order",
      source: account("revenue", 7),
    });
    const plain = namedLeg("sale", { eventGroup: "evt-order", kind: "sale" });
    const [sale, reversal] = await storedInOrder([plain, refund]);
    expect("reversesGroup" in sale!).toBe(false);
    expect(reversal!.reversesGroup).toBe("evt-order");
  });
});
