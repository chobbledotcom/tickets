/**
 * An inclusive-start / exclusive-end date range over the ledger's `occurred_at`
 * (stored as an INTEGER epoch-ms business time), plus the tiny SQL-fragment
 * helpers that bound a query to it. Kept separate from the projection-sql
 * builders because a range carries *bound values* (the millisecond bounds),
 * whereas those builders interpolate column expressions only.
 *
 * Either bound may be null, meaning "unbounded on that side" — a fully-null
 * range (the {@link emptyRange} default) selects the whole ledger ("forever").
 */

import type { WhereClause } from "#shared/db/where-clauses.ts";

/** A bounded window over `occurred_at`: `startMs` ≤ occurred_at < `endMs`. A
 *  null bound is open on that side; both null is "forever". */
export type LedgerRange = {
  /** Inclusive lower epoch-ms bound, or null for no lower bound. */
  readonly startMs: number | null;
  /** Exclusive upper epoch-ms bound, or null for no upper bound. */
  readonly endMs: number | null;
};

/** The unbounded range — selects every transfer ("forever"). */
export const emptyRange: LedgerRange = { endMs: null, startMs: null };

/**
 * The `occurred_at` bounds of a range as filter clauses — one per bound that is
 * set, none for an unbounded range. Compose them with the other clauses of a
 * ledger read and let `whereSql` build the tail.
 */
export const occurredAtRange = (
  range: LedgerRange,
  column = "occurred_at",
): WhereClause[] => [
  ...(range.startMs === null
    ? []
    : [{ args: [range.startMs], clause: `${column} >= ?` }]),
  ...(range.endMs === null
    ? []
    : [{ args: [range.endMs], clause: `${column} < ?` }]),
];
