/** The heart of every scan: given one ticket's rows, decide what a door's
 * scan admits. Pure data-in/data-out. The routes in scanner.ts turn the
 * decision into responses and writes, so every door (one listing or a whole
 * group) decides through this one rule. */

import { remainingTickets } from "#booking/remaining-tickets.ts";
import { groupToMap, sumOf } from "#fp";
import type { TokenEntry } from "#routes/tickets/token-utils.ts";

/** One listing's share of one admission: the rows the scan admits there, and
 * how many tickets it admits on them. The count is never more than those
 * rows owe. A parent row and its folded child row sit on different listings,
 * so one admission never counts them as one person twice. */
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

/** One ticket's lines grouped by listing, in booking order, with the
 * listings that owe no place dropped. A listing whose lines all sit fully
 * checked in keeps its place in the order. A one-listing-per-scan door then
 * lands on the listing after it, never past it. */
export const owingListings = <Row>(
  lines: readonly Row[],
  listingIdOf: (row: Row) => number,
  remainingOf: (row: Row) => number,
): Row[][] =>
  [...groupToMap(listingIdOf, (row: Row) => row)(lines).values()].filter(
    (rows) => rows.some((row) => remainingOf(row) > 0),
  );

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
 * when the ask forces a ticket that matched nowhere in scope. A "No
 * check-in" listing sells with no door, so its rows never admit on any
 * door. The ticket-QR path refuses them too, and force never widens onto
 * them. */
const scanPool = ({
  entries,
  scope,
  force,
}: DoorAsk):
  | { failure: "not_found" | "wrong_listing" }
  | { rows: TokenEntry[]; widened: boolean } => {
  const doorSafe = entries.filter((entry) => !entry.listing.purchase_only);
  const inScope = doorSafe.filter((entry) => scope.has(entry.listing.id));
  if (!force || inScope.length > 0) {
    return inScope.length === 0
      ? { failure: "wrong_listing" }
      : { rows: inScope, widened: false };
  }
  if (doorSafe.length > 0) return { rows: doorSafe, widened: true };
  return { failure: entries.length === 0 ? "not_found" : "wrong_listing" };
};

/** The listings a scan admits from those that still owe tickets. Every one
 * for a group door that checks in all its listings, and otherwise the first.
 * Every later door of a several-listing ticket still has something to admit. */
export const scanAdmits = <Row>(
  widened: boolean,
  checkInEveryListing: boolean,
  owed: readonly Row[][],
): Row[][] => (checkInEveryListing && !widened ? [...owed] : [owed[0]!]);

/** The tickets one listing's rows still owe the door. */
const owedTickets = sumOf((row: TokenEntry) => remainingTickets(row.attendee));

/** The places one set of scan units admits in all. */
export const unitTickets: (units: readonly ScanUnit[]) => number = sumOf(
  (unit: ScanUnit) => unit.tickets,
);

/** Decide one scan. The ask names the ticket's rows, the listings the door
 * admits, and the door staff's let-them-in-anyway choice for a ticket that
 * matches nowhere in scope. `checkInEveryListing` is the group's stored
 * checkbox. A non-transferable listing holds the ticket until `idVerified`
 * says the door staff checked the person's ID. `count` is the door's answer
 * to a `select_quantity` ask: that many tickets admit on every listing the
 * scan covers, capped by what each listing still owes. Without it, a scan
 * that covers a line owing more than one ticket asks first. A line owing
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
  const owed = owingListings(
    live,
    (entry) => entry.listing.id,
    (entry) => remainingTickets(entry.attendee),
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
    remaining: sumOf(owedTickets)(owed) - unitTickets(units),
    rows,
    units,
  };
};

/** A queued delivery's share of one admit decision. Fill the decision's
 * units in booking order until the pick is met or the listings run out.
 * Each listing caps at what it still owes. The plan therefore never
 * exceeds the pick, and it can fall short of it. The answer then reports
 * the shortfall. A live scan's quantity pick caps per listing instead.
 * Only a queued delivery admits an exact count. */
export const quantityAdmission = (
  decision: Extract<ScanDecision, { kind: "admit" }>,
  quantity: number,
): Extract<ScanDecision, { kind: "admit" }> => {
  const planned: ScanUnit[] = [];
  decision.units.reduce((remaining: number, unit) => {
    if (remaining <= 0) return remaining;
    const take = Math.min(unit.tickets, remaining);
    planned.push({ rows: unit.rows, tickets: take });
    return remaining - take;
  }, quantity);
  return {
    ...decision,
    remaining:
      decision.remaining + unitTickets(decision.units) - unitTickets(planned),
    rows: planned.flatMap((unit) => [...unit.rows]),
    units: planned,
  };
};
