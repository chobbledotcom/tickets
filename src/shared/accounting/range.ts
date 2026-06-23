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

import type { InValue } from "@libsql/client";

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
 * The bare `occurred_at` predicate for a range (no leading `WHERE`/`AND`), with
 * its bound args. Returns an empty clause for an unbounded range so callers can
 * compose it with {@link andPrefixed} / {@link wherePrefixed} without emitting a
 * dangling connector.
 */
export const occurredAtRange = (
  range: LedgerRange,
): { clause: string; args: InValue[] } => {
  const parts: string[] = [];
  const args: InValue[] = [];
  if (range.startMs !== null) {
    parts.push("occurred_at >= ?");
    args.push(range.startMs);
  }
  if (range.endMs !== null) {
    parts.push("occurred_at < ?");
    args.push(range.endMs);
  }
  return { args, clause: parts.join(" AND ") };
};

/** Prefix a non-empty clause with ` AND `, else the empty string. */
export const andPrefixed = (clause: string): string =>
  clause ? ` AND ${clause}` : "";

/** Prefix a non-empty clause with ` WHERE `, else the empty string. */
export const wherePrefixed = (clause: string): string =>
  clause ? ` WHERE ${clause}` : "";
