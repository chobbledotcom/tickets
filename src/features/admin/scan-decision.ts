/** The heart of every scan: given one ticket's rows, decide what a door's
 * scan admits. Pure data-in/data-out — the routes in scanner.ts turn the
 * decision into responses and writes, so every door (one listing or a whole
 * group) decides through this one rule. */

import { remainingTickets } from "#booking/remaining-tickets.ts";
import { groupToMap, sumOf } from "#fp";
import type { TokenEntry } from "#routes/tickets/token-utils.ts";

/** One listing's share of one admission: the rows the scan admits there, and
 * how many tickets it admits on them — never more than those rows owe. */
export type ScanUnit = { rows: TokenEntry[]; tickets: number };

/** What one scan decided. An admit's `remaining` is every ticket the
 * door's listings still owe the person after this scan. */
export type ScanDecision =
  | { kind: "admit"; remaining: number; rows: TokenEntry[]; units: ScanUnit[] }
  | { kind: "select_quantity"; max: number; rows: TokenEntry[] }
  | { kind: "already_checked_in"; live: TokenEntry[] }
  | { kind: "verify_id"; rows: TokenEntry[] }
  | { kind: "refunded" }
  | { kind: "wrong_listing" }
  | { kind: "not_found" };

/** All of one ticket's rows on one listing, in booking order — one
 * admission unit. A booking's rows on one listing are one person's places
 * there. A parent row and its folded child row sit on different listings, so
 * admitting one unit at a time never counts them as one person twice. */
export const rowsByListing = (rows: readonly TokenEntry[]): TokenEntry[][] => [
  ...groupToMap(
    (row: TokenEntry) => row.listing.id,
    (row: TokenEntry) => row,
  )(rows).values(),
];

/** What a door asks a scan to decide: the ticket's rows, the listings the
 * door admits, and the door staff's let-them-in-anyway choice. `force` only
 * ever widens — a ticket that matches in scope is decided by the listings it
 * matched, exactly as the listing scanner always has. */
type DoorAsk = {
  entries: readonly TokenEntry[];
  scope: ReadonlySet<number>;
  force: boolean;
};

/** Where a scan looks for rows: the door's own listings, or every listing
 * when the ask forces a ticket that matched nowhere in scope. */
const scanPool = ({
  entries,
  scope,
  force,
}: DoorAsk):
  | { failure: "not_found" | "wrong_listing" }
  | { rows: TokenEntry[]; widened: boolean } => {
  const inScope = entries.filter((entry) => scope.has(entry.listing.id));
  if (!force || inScope.length > 0) {
    return inScope.length === 0
      ? { failure: "wrong_listing" }
      : { rows: inScope, widened: false };
  }
  return entries.length === 0
    ? { failure: "not_found" }
    : { rows: [...entries], widened: true };
};

/** The listings a scan admits from those that still owe tickets: every one
 * for a group door that checks in all its listings, otherwise the first, so
 * every later door of a several-listing ticket still has something to admit. */
const scanAdmits = (
  widened: boolean,
  checkInEveryListing: boolean,
  owed: readonly TokenEntry[][],
): TokenEntry[][] => (checkInEveryListing && !widened ? [...owed] : [owed[0]!]);

/** The tickets one listing's rows still owe the door. */
const owedTickets = sumOf((row: TokenEntry) => remainingTickets(row.attendee));

/** Decide one scan. The ask names the ticket's rows, the listings the door
 * admits, and the door staff's let-them-in-anyway choice for a ticket that
 * matches nowhere in scope. `checkInEveryListing` is the group's stored
 * checkbox. A non-transferable listing holds the ticket until `idVerified`
 * says the door staff checked the person's ID. `count` is the door's answer
 * to a `select_quantity` ask: that many tickets admit on every listing the
 * scan covers, capped by what each listing still owes. Without it, a scan
 * that covers a line owing more than one ticket asks first; a line owing
 * exactly one admits straight in. */
export const decideScan = (
  { entries, scope, force }: DoorAsk,
  checkInEveryListing: boolean,
  idVerified: boolean,
  count?: number,
): ScanDecision => {
  const pool = scanPool({ entries, force, scope });
  if ("failure" in pool) return { kind: pool.failure };
  const live = pool.rows.filter((entry) => !entry.attendee.refunded);
  if (live.length === 0) return { kind: "refunded" };
  const owed = rowsByListing(live).filter((rows) =>
    rows.some((entry) => remainingTickets(entry.attendee) > 0),
  );
  if (owed.length === 0) return { kind: "already_checked_in", live };
  const admitted = scanAdmits(pool.widened, checkInEveryListing, owed);
  const rows = admitted.flat();
  if (!idVerified && rows.some((entry) => entry.listing.non_transferable)) {
    return { kind: "verify_id", rows };
  }
  const perListing = admitted.map(owedTickets);
  const wantsChoice =
    count === undefined && perListing.some((tickets) => tickets > 1);
  if (wantsChoice) {
    return { kind: "select_quantity", max: Math.max(...perListing), rows };
  }
  const share = count ?? 1;
  const units = admitted.map((unitRows, index) => ({
    rows: unitRows,
    tickets: Math.min(share, perListing[index]!),
  }));
  return {
    kind: "admit",
    remaining:
      sumOf(owedTickets)(owed) - sumOf((unit: ScanUnit) => unit.tickets)(units),
    rows,
    units,
  };
};
