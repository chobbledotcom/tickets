/** One scanner door as the routes behind it read it. A door is a listing
 * door or a group door, with the scope it admits. The roster rule names the
 * people the door can still check in. The cache pages, the name search, and
 * the scanner page all load a door the same way. */

import { remainingTickets } from "#booking/remaining-tickets.ts";
import { deriveDoorCacheKey } from "#crypto/hashing.ts";
import { toBase64Url } from "#crypto/utils.ts";
import type { DecryptedAttendeeRow } from "#db/attendees/pii.ts";
import type { BrowsingAttendee } from "#db/attendees/queries.ts";
import { getGroupById } from "#db/groups.ts";
import { getListingPickerNames } from "#db/listings/catalog.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { groupToMap, sumOf } from "#fp";
import { type AuthSession, SCANNER_JSON, withAuth } from "#routes/auth.ts";
import type { IdRouteHandler } from "#routes/entity.ts";
import { jsonResponse } from "#routes/response.ts";
import {
  type AdminDestinationId,
  adminRecordPath,
} from "#shared/admin-surface.ts";
import { formatDateLabel } from "#shared/date-labels.ts";
import type { RosterOption } from "#shared/roster-option.ts";
import type { DoorPaths } from "#templates/admin/scanner.tsx";
import { hasTicketQuantity } from "#types";
import { groupScope, listingScope, type ScanScope } from "./scan-answer.ts";
import { listingHasDoor, owingListings, scanAdmits } from "./scan-decision.ts";

/** The name a door's cache key derives from: the door's kind and id. The
 * cache endpoint and the scanner page derive the same key from the same
 * name. */
export const doorCacheName = (kind: "group" | "listing", id: number): string =>
  `${kind}:${id}`;

/** Each door kind's routes, by their names in the admin surface table. */
/* jscpd:ignore-start -- static data, not code */
const DOOR_ROUTES = {
  group: {
    cache: "groupScanCache",
    scan: "groupScan",
    search: "groupScanSearch",
  },
  listing: {
    cache: "listingScanCache",
    scan: "listingScan",
    search: "listingScanSearch",
  },
} as const satisfies Record<
  "group" | "listing",
  Record<keyof DoorPaths, AdminDestinationId>
>;
/* jscpd:ignore-end */

/** One door's routes, built from the routes the admin surface declares. */
export const doorPaths = (kind: "group" | "listing", id: number): DoorPaths => {
  const routes = DOOR_ROUTES[kind];
  return {
    cache: adminRecordPath(routes.cache, id),
    scan: adminRecordPath(routes.scan, id),
    search: adminRecordPath(routes.search, id),
  };
};

/** The door's cache key as the scanner page carries it: base64url bytes the
 * device decodes before it digests a scan. The page is the only response
 * that holds a door's key, so a copied cache response alone digests
 * nothing. */
export const pageDoorCacheKey = (door: string): string =>
  toBase64Url(deriveDoorCacheKey(door));

/** One door. `door` is the name its cache key derives from. `name` is the
 * door's own name for the activity log. `listingId` is the listing a log
 * entry belongs to, or null for a group door. */
export type ScanDoor = {
  door: string;
  listingId: number | null;
  name: string;
  scope: ScanScope;
};

/** The name of each listing a door spans, or null for a one-listing door,
 * whose own page title already names its listing. */
export type ListingNames = ReadonlyMap<number, string> | null;

/** Load one door by id. Null is the documented answer for a door that does
 * not exist, or a listing marked "No check-in". */
export type ScanDoorLoader = (id: number) => Promise<ScanDoor | null>;

/** One call to a door route: the request, its parsed JSON body, and the
 * session that sent it. */
export type DoorCall = {
  body: Record<string, unknown>;
  request: Request;
  session: AuthSession;
};

/** One JSON route at one door. It loads the door by id and hands it, with
 * the call, to `answer`. A door that does not exist answers 404 with the
 * scan API's `not_found`, never an empty scope. A broken link then cannot
 * pass every ticket off as "wrong listing". */
export const doorRoute =
  (answer: (door: ScanDoor, call: DoorCall) => Promise<Response>) =>
  (load: ScanDoorLoader): IdRouteHandler =>
  (request, { id }) =>
    withAuth(request, SCANNER_JSON, async (session, body) => {
      const door = await load(id);
      return door
        ? answer(door, { body, request, session })
        : jsonResponse({ status: "not_found" }, 404);
    });

/** The listing door. A "No check-in" listing has no door, so a guessed URL
 * meets the same answer as an unknown listing. */
export const loadListingDoor: ScanDoorLoader = async (id) => {
  const listing = await getListingWithCount(id);
  return !listing || !listingHasDoor(listing)
    ? null
    : {
        door: doorCacheName("listing", id),
        listingId: id,
        name: listing.name,
        scope: listingScope(id),
      };
};

/** The names of the listings a door spans, or null for a one-listing door.
 * Only the routes that show a person's details read them. */
export const doorListingNames = async (
  scope: ScanScope,
): Promise<ListingNames> =>
  scope.listingIds.size > 1
    ? new Map(
        [...(await getListingPickerNames())]
          .filter(([id]) => scope.listingIds.has(id))
          .map(([id, listing]) => [id, listing.name] as const),
      )
    : null;

/** The group door. A missing group answers 404 rather than an empty set, so
 * a broken link cannot pass every ticket off as absent. */
export const loadGroupDoor: ScanDoorLoader = async (id) => {
  const group = await getGroupById(id);
  return group
    ? {
        door: doorCacheName("group", id),
        listingId: null,
        name: group.name,
        scope: await groupScope(group),
      }
    : null;
};

/** What a door's roster rules read off one decrypted booking line: its
 * identity, its places, its day, its listing, and its refund state. The
 * roster read and the offline list's page read both carry these. */
export type RosterLine = Pick<
  DecryptedAttendeeRow<BrowsingAttendee>,
  "checked_in" | "date" | "id" | "listing_id" | "name" | "quantity" | "refunded"
>;

/** The door-safe facts that tell two people with the same name apart. They
 * name the listing when a door spans several, and the day each place is
 * for. The ticket's own page shows the same facts to a door-only login. A
 * line with neither fact adds nothing. */
export const optionDetails = (
  rows: readonly RosterLine[],
  listingNames: ListingNames,
): string[] => [
  ...new Set(
    rows
      .map((row) =>
        [
          listingNames?.get(row.listing_id) ?? "",
          row.date ? formatDateLabel(row.date) : "",
        ]
          .filter(Boolean)
          .join(" · "),
      )
      .filter(Boolean),
  ),
];

/** Whether one line can still be checked in: it owes places, it is not
 * refunded, and it carries ticket quantity. */
export const lineOwes = (line: RosterLine): boolean =>
  remainingTickets(line) > 0 && !line.refunded && hasTicketQuantity(line);

/** One person's facts as the door's own rule computes them. They name the
 * places of their booking that one check-in at this door admits. They also
 * name the details that tell two people with the same name apart. Null
 * when the door owes the person nothing: such a person has no place in the
 * roster or the offline list. */
export const personFacts = (
  lines: readonly RosterLine[],
  checkInEveryListing: boolean,
  listingNames: ListingNames,
): { details: string[]; name: string; quantity: number } | null => {
  // One line that can still admit admits the person, so any of the
  // person's tickets at this door goes in the list.
  const live = lines.filter((row) => !row.refunded && hasTicketQuantity(row));
  // The scan groups every line it can see before it drops the listings
  // that owe nothing. The count therefore names the listing that scan
  // lands on, even when an earlier line on it sits fully checked in.
  const owed = owingListings(live, (row) => row.listing_id, remainingTickets);
  if (owed.length === 0) return null;
  // What one scan admits, by the scan's own rule: the first listing still
  // owing places, or every one when this door checks them all in.
  const admitted = scanAdmits(false, checkInEveryListing, owed);
  return {
    details: optionDetails(lines.filter(lineOwes), listingNames),
    name: lines[0]!.name,
    quantity: sumOf(sumOf(remainingTickets))(admitted),
  };
};

/** The people the door can still check in, one option for each person.
 * Each option's count is what one check-in at this door admits, by the
 * door's own rule. The same person then reads the same number in the
 * search and on the saved offline list. */
export const doorRoster = (
  attendees: readonly RosterLine[],
  checkInEveryListing: boolean,
  listingNames: ListingNames,
): RosterOption[] =>
  [
    ...groupToMap(
      (line: RosterLine) => line.id,
      (line: RosterLine) => line,
    )([...attendees]).values(),
  ].flatMap((rows: RosterLine[]) => {
    const facts = personFacts(rows, checkInEveryListing, listingNames);
    return facts === null ? [] : [{ attendeeId: rows[0]!.id, ...facts }];
  });
