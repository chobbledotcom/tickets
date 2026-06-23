import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { insertStatement } from "#shared/accounting/rows.ts";
import { account } from "#shared/ledger/account.ts";
import type { TransferInput } from "#shared/ledger/types.ts";

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
