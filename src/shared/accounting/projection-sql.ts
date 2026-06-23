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
 * A scalar subquery for the GROSS credits to an account *minus* only its
 * write-off debits, aliased `alias`. Income is the gross sum of revenue credits
 * (deliberately NOT `balanceOf`, so an ordinary refund — `revenue:L→attendee` —
 * does not reduce it, matching the legacy `SUM(price_paid)`), but a *manual*
 * write-off (`revenue:L→writeoff`, decision 14) must lower it. So this sums the
 * dest-side credits and subtracts the amounts the account paid out specifically
 * to the `writeoff` contra account, ignoring every other source-side leg. With
 * zero `writeoff` legs (production today) it equals the plain gross credit sum.
 * `idExpr` is the SQL for the account id in the surrounding query.
 */
export const creditsLessWriteoffDebits = (
  type: string,
  idExpr: string,
  alias: string,
): string => {
  const credited = accountPredicate("dest", type, idExpr);
  const writtenOff = `${accountPredicate("source", type, idExpr)} AND dest_type = 'writeoff'`;
  return (
    "(SELECT COALESCE(SUM(" +
    `CASE WHEN ${credited} THEN amount WHEN ${writtenOff} THEN -amount ELSE 0 END` +
    `), 0) FROM transfers WHERE ${credited} OR ${writtenOff}) AS ${alias}`
  );
};

/**
 * A *bare* scalar subquery (no alias) for an account's net ledger balance: money
 * in as the destination minus money out as the source — the same signed sum the
 * TS-side `balanceOf` computes. The caller names it and chooses the sign: a
 * revenue/modifier account reads it directly (`balance AS income`), while an
 * "owed" figure negates it (outstanding = `-balance`). Scanning only the
 * account's own legs (`<dest> OR <source>`) keeps it index-backed.
 */
export const accountBalanceSubquery = (
  type: string,
  idExpr: string,
): string => {
  const asDest = accountPredicate("dest", type, idExpr);
  const asSource = accountPredicate("source", type, idExpr);
  return (
    "(SELECT COALESCE(SUM(" +
    `CASE WHEN ${asDest} THEN amount WHEN ${asSource} THEN -amount ELSE 0 END` +
    `), 0) FROM transfers WHERE ${asDest} OR ${asSource})`
  );
};

/**
 * The bare subquery for what an attendee still owes: the negation of their net
 * account balance (outstanding = −balance). The single place the "owed equals
 * negative balance" sign convention lives, so the read column, the settle guard,
 * and the finalize guard can't drift apart. Callers alias it
 * (`… AS remaining_balance`) or compare it in a guard (`… = ?`).
 */
export const attendeeOwedSubquery = (idExpr: string): string =>
  `-${accountBalanceSubquery("attendee", idExpr)}`;
