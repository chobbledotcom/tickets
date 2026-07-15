/**
 * Pure checks and sums for picking legs out of a slice of transfers — the
 * in-memory mirror of the SQL leg checks in `accounting/projection-sql.ts`. A
 * "leg" is one persisted {@link Transfer}; these answer "is this leg of kind K,
 * sourced from account A, paid to account B?" and "add up the legs that match",
 * so every in-memory reader classifies a leg the same way the SQL reads do.
 * This is the TS half of the ledger's TS/SQL pair, the way {@link balanceOf} is
 * to `signedSumCase`: the shape lives once on each side, and account sides are
 * always compared with {@link sameAccount} rather than open-coded.
 */

import { sumOf } from "#fp";
import { sameAccount } from "./account.ts";
import type { AccountRef, Transfer } from "./types.ts";

/**
 * Which parts of a leg to match. An omitted field matches any value, so
 * `{ kind }` matches on kind alone, `{ kind, from }` also pins the source
 * account, and `{ kind, from, to }` pins both sides.
 */
export type LegSpec = {
  readonly kind?: string;
  readonly from?: AccountRef;
  readonly to?: AccountRef;
};

/**
 * A check that keeps legs matching every field the spec names. The single home
 * for "is this the leg I mean" in memory: the source and destination are
 * compared with {@link sameAccount}, so no caller re-inlines the (type, id)
 * equality the way the raw `leg.source.type === … && leg.source.id === …` check
 * used to.
 */
export const legMatches =
  (spec: LegSpec): ((leg: Transfer) => boolean) =>
  (leg) =>
    (spec.kind === undefined || leg.kind === spec.kind) &&
    (spec.from === undefined || sameAccount(leg.source, spec.from)) &&
    (spec.to === undefined || sameAccount(leg.destination, spec.to));

/**
 * Add up the amounts of the legs a check keeps, or 0 when none match — the one
 * sum behind every "total of these legs" read (a kind total, one booking's
 * recognised sale). Pair it with {@link legMatches} to total a specific leg.
 */
export const sumLegs =
  (
    matches: (leg: Transfer) => boolean,
  ): ((legs: readonly Transfer[]) => number) =>
  (legs) =>
    sumOf((leg: Transfer) => (matches(leg) ? leg.amount : 0))(legs);
