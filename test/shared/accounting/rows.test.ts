import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  bookingLegBatchInsert,
  fromDb,
  insertStatement,
  selectTransfers,
} from "#shared/accounting/rows.ts";
import { executeBatch } from "#shared/db/client.ts";
import { account } from "#shared/ledger/account.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
import { useTransactionalDb } from "#test-utils/ledger.ts";

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
  return statement.args[columns.indexOf(column)];
};

describe("accounting > rows > insertStatement", () => {
  const base: TransferInput = {
    amount: 5000,
    destination: account("revenue", 1),
    eventGroup: "evt",
    occurredAt: "2026-06-21T00:00:00.000Z",
    reference: "ref",
    source: account("attendee", 1),
  };
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
  const leg: TransferInput = {
    amount: 5000,
    destination: account("revenue", 9),
    eventGroup: "evt",
    kind: "sale",
    occurredAt: "2026-06-21T00:00:00.000Z",
    reference: "ref",
    source: account("attendee", 3),
  };
  const guard = { args: ["g"], sql: "? = 'g'" };

  test("renders ONLY the attendee side via the in-batch id subquery", () => {
    const built = bookingLegBatchInsert(leg, recordedAt, "MAX(id)", 7, guard);
    // source is the attendee account -> subquery; destination (revenue) stays a
    // bound literal. Swapping the two would post the sale to a phantom account.
    expect(built.sql).toContain("CAST(MAX(id) AS TEXT)");
    expect(built.sql.indexOf("CAST(MAX(id) AS TEXT)")).toBe(
      built.sql.lastIndexOf("CAST(MAX(id) AS TEXT)"),
    );
    expect(built.args).toContain(7); // the subquery's bound arg
    expect(built.args).toContain("9"); // revenue id still a bound literal
    expect(built.args).not.toContain("3"); // attendee id replaced by subquery
    expect(built.args.at(-1)).toBe("g"); // guard args come last
    expect(built.sql).toMatch(/^INSERT OR IGNORE INTO transfers /);
    expect(built.sql).toContain("WHERE ? = 'g'");
  });
});

describe("accounting > rows > stored-row round-trip", () => {
  useTransactionalDb();
  const recordedAt = "2026-06-21T12:00:00.000Z";

  test("selectTransfers reads every column back, reversesId present and absent", async () => {
    const plain: TransferInput = {
      amount: 5000,
      destination: account("revenue", 7),
      eventGroup: "evt-plain",
      kind: "sale",
      memo: "first",
      occurredAt: "2026-06-21T00:00:00.000Z",
      reference: "ref-plain",
      source: account("attendee", 3),
    };
    // A void leg carrying a (non-FK) reverses_id, so the NULL vs real-id branch of
    // the row→Transfer mapping is exercised both ways.
    const voiding: TransferInput = {
      ...plain,
      eventGroup: "evt-void",
      kind: "void",
      reference: "ref-void",
      reversesId: 999,
    };
    await executeBatch([
      insertStatement(plain, recordedAt),
      insertStatement(voiding, recordedAt),
    ]);

    const all = await selectTransfers(fromDb, " ORDER BY id", []);
    expect(all.length).toBe(2);
    const [first, second] = all;

    // Full-fidelity round-trip — a corrupted SELECT column list loses these.
    expect(first!.amount).toBe(5000);
    expect(first!.source).toEqual(account("attendee", 3));
    expect(first!.destination).toEqual(account("revenue", 7));
    expect(first!.reference).toBe("ref-plain");
    expect(first!.eventGroup).toBe("evt-plain");
    expect(first!.kind).toBe("sale");
    expect(first!.memo).toBe("first");
    expect(first!.occurredAt).toBe("2026-06-21T00:00:00.000Z");

    // NULL reverses_id maps to undefined; a real id maps to the Number.
    expect(first!.reversesId).toBeUndefined();
    expect(second!.reversesId).toBe(999);
  });

  test("a kindless leg stores as '' and reads back with kind omitted", async () => {
    const kindless: TransferInput = {
      amount: 100,
      destination: account("revenue", 7),
      eventGroup: "evt-kindless",
      occurredAt: "2026-06-21T00:00:00.000Z",
      reference: "ref-kindless",
      source: account("attendee", 3),
    };
    await executeBatch([insertStatement(kindless, recordedAt)]);
    const [stored] = await selectTransfers(fromDb, "", []);
    // Omitted, not "": a stored transfer and a never-stored input must agree
    // on what "no kind" looks like (mirroring reverses_id).
    expect(stored!.kind).toBeUndefined();
    expect("kind" in stored!).toBe(false);
  });
});
