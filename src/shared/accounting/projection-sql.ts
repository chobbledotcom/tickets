/**
 * SQL-fragment builders for projecting figures off the `transfers` ledger at
 * read time (income, amount paid, refund status, …). These centralise the
 * transfers-table column names and the integer-id → TEXT cast in one place, so
 * every projection filters accounts identically and a typo in `source_id` /
 * `dest_type` / the `CAST(… AS TEXT)` can't silently skew a single read.
 *
 * They build raw SQL by interpolating caller-supplied column *expressions*
 * (e.g. `ea.attendee_id`), not bound values — for binding a known account use
 * the parameterised `transfersByAccount` in `./queries.ts` instead.
 */

/** Account type/id columns for one leg side of a `transfers` row. */
const COLUMNS = {
  dest: { id: "dest_id", type: "dest_type" },
  source: { id: "source_id", type: "source_type" },
} as const;

/**
 * A `transfers` account-match predicate for one leg side: `<role>_type = '<type>'
 * AND <role>_id = CAST(<idExpr> AS TEXT)`. `role` picks the source or destination
 * side; `type` is the account type (`'attendee'`, `'revenue'`, …); `idExpr` is
 * the SQL for the account id in the surrounding query. Ledger ids are stored as
 * TEXT, so the id expression is CAST so an integer column still matches.
 */
export const accountPredicate = (
  role: "source" | "dest",
  type: string,
  idExpr: string,
): string => {
  const col = COLUMNS[role];
  return `${col.type} = '${type}' AND ${col.id} = CAST(${idExpr} AS TEXT)`;
};

/**
 * Wrap a `transfers` WHERE clause as a scalar gross-sum subquery aliased
 * `alias` — the shape every "sum of amounts over the filtered legs" projection
 * shares. `where` is the predicate body (no leading `WHERE`). A site has one
 * currency, so amounts sum directly.
 */
export const sumAmountFromTransfers = (where: string, alias: string): string =>
  `(SELECT COALESCE(SUM(amount), 0) FROM transfers WHERE ${where}) AS ${alias}`;

/**
 * A *bare* scalar subquery (no alias) for an account's net ledger balance: money
 * in as the destination minus money out as the source — the same signed sum the
 * TS-side `balanceOf` computes. The caller names it and chooses the sign: a
 * revenue/modifier account reads it directly (`balance AS income`), while an
 * "owed" figure negates it (outstanding = `-balance`). Scanning only the
 * account's own legs (`<dest> OR <source>`) keeps it index-backed.
 */
export const accountBalanceSubquery = (type: string, idExpr: string): string => {
  const asDest = accountPredicate("dest", type, idExpr);
  const asSource = accountPredicate("source", type, idExpr);
  return (
    `(SELECT COALESCE(SUM(` +
    `CASE WHEN ${asDest} THEN amount WHEN ${asSource} THEN -amount ELSE 0 END` +
    `), 0) FROM transfers WHERE ${asDest} OR ${asSource})`
  );
};
