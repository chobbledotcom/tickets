// effects: pure
/**
 * An inclusive-start / exclusive-end date range over the ledger's `occurred_at`
 * (stored as an INTEGER epoch-ms business time). The tiny SQL-fragment
 * helpers here bound a query to it. Kept separate from the projection-sql
 * builders because a range carries *bound values* (the millisecond bounds),
 * whereas those builders interpolate column expressions only.
 *
 * Either bound can be null, meaning "unbounded on that side" — a fully-null
 * range (the {@link emptyRange} default) selects the whole ledger ("forever").
 */

import { atLeast, type Condition, lessThan } from "#db/select/expression.ts";
import { tableNode } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";

/** The ledger row of a statement written by hand. The statement must name
 *  the table `transfers AS transfer`, the word a read from the builder uses. */
export const LEDGER_ROW = tableNode(tables.transfers, "transfer");

/** A bounded window over `occurred_at`: `startMs` ≤ occurred_at < `endMs`. A
 *  null bound is open on that side, and both null is "forever". */
export type LedgerRange = {
  /** Inclusive lower epoch-ms bound, or null for no lower bound. */
  readonly startMs: number | null;
  /** Exclusive upper epoch-ms bound, or null for no upper bound. */
  readonly endMs: number | null;
};

/** The unbounded range — selects every transfer ("forever"). */
export const emptyRange: LedgerRange = { endMs: null, startMs: null };

/**
 * The `occurred_at` bounds of a range as conditions: one for each bound that
 * is set, none for an unbounded range. They read the ledger row of a statement
 * that names the table `transfers AS transfer`.
 */
export const occurredAtRange = (range: LedgerRange): Condition[] => [
  ...(range.startMs === null
    ? []
    : [atLeast(LEDGER_ROW.occurred_at, range.startMs)]),
  ...(range.endMs === null
    ? []
    : [lessThan(LEDGER_ROW.occurred_at, range.endMs)]),
];
