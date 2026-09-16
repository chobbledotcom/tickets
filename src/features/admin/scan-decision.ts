/** The heart of every scan: given one ticket's rows, decide what a door's
 * scan admits. Pure data-in/data-out — the routes in scanner.ts turn the
 * decision into responses and writes, so every door (one listing or a whole
 * group) decides through this one rule. */

import { groupToMap } from "#fp";
import type { TokenEntry } from "#routes/tickets/token-utils.ts";

/** What one scan decided. */
export type ScanDecision =
  | { kind: "admit"; remaining: number; rows: TokenEntry[] }
  | { kind: "already_checked_in"; live: TokenEntry[] }
  | { kind: "verify_id"; rows: TokenEntry[] }
  | { kind: "refunded" }
  | { kind: "wrong_listing" }
  | { kind: "not_found" };

/** All of one ticket's rows on one listing, in booking order — one
 * admission unit. Checking a whole unit in is one write, because a booking's
 * rows on one listing are one person's places there. A parent row and its
 * folded child row sit on different listings, so admitting one unit at a
 * time never counts them as one person twice. */
export const rowsByListing = (rows: readonly TokenEntry[]): TokenEntry[][] => [
  ...groupToMap(
    (row: TokenEntry) => row.listing.id,
    (row: TokenEntry) => row,
  )(rows).values(),
];

/** Decide one scan. `scope` holds the listing ids this door admits. `force`
 * widens a ticket that matches nowhere in scope to all its listings, the
 * door staff's "let them in anyway". `checkInEveryListing` is the group's
 * stored checkbox: when set, one scan admits every listing with an unchecked
 * live row; otherwise each scan admits one listing at a time, so every later
 * door of a several-listing ticket still has something to admit. A
 * non-transferable listing holds the ticket until `idVerified` says the
 * door staff checked the person's ID. */
export const decideScan = (
  entries: readonly TokenEntry[],
  scope: ReadonlySet<number>,
  force: boolean,
  checkInEveryListing: boolean,
  idVerified: boolean,
): ScanDecision => {
  const inScope = entries.filter((entry) => scope.has(entry.listing.id));
  // `force` only ever widens: a ticket that matches in scope is decided by
  // the listings it matched, exactly as the listing scanner always has.
  const pool = force && inScope.length === 0 ? [...entries] : inScope;
  if (pool.length === 0) {
    return entries.length === 0 && force
      ? { kind: "not_found" }
      : { kind: "wrong_listing" };
  }
  const live = pool.filter((entry) => !entry.attendee.refunded);
  if (live.length === 0) return { kind: "refunded" };
  const unchecked = rowsByListing(live).filter((rows) =>
    rows.some((entry) => !entry.attendee.checked_in),
  );
  if (unchecked.length === 0) return { kind: "already_checked_in", live };
  const admitted = checkInEveryListing ? unchecked : [unchecked[0]!];
  const rows = admitted.flat();
  if (!idVerified && rows.some((entry) => entry.listing.non_transferable)) {
    return { kind: "verify_id", rows };
  }
  return { kind: "admit", remaining: unchecked.length - admitted.length, rows };
};
