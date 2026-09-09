/**
 * Whether one ledger leg exactly undoes another — the check the store runs on
 * a leg carrying a `reversesId` before it inserts it.
 */

import { sameAccount } from "./account.ts";
import type { AccountRef } from "./types.ts";

/** The fields that decide whether one leg exactly undoes another. */
type DirectedAmount = {
  readonly amount: number;
  readonly source: AccountRef;
  readonly destination: AccountRef;
};

/**
 * True when `leg` exactly undoes `original`: same amount, with source and
 * destination swapped. The store checks a leg carrying a `reversesId` against
 * this before inserting, so a bad link can't void nothing.
 */
export const isInverseOf = (
  leg: DirectedAmount,
  original: DirectedAmount,
): boolean =>
  leg.amount === original.amount &&
  sameAccount(leg.source, original.destination) &&
  sameAccount(leg.destination, original.source);
