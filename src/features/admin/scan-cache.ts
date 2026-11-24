/** The offline scan cache one door serves: keyed digests of the ticket
 * tokens its door can currently admit. Each digest is HMAC-SHA256 under a
 * key only the door's scanner page carries. A copied cache response alone
 * digests nothing. The scanner page downloads the list in pages when the door
 * turns offline mode on. A scan with no connection then answers from the
 * digests alone. The offline quantity ask bounds its pick at the stored
 * count. The device never holds the tokens of tickets it has not scanned,
 * and never holds any guest detail from this endpoint. */

import { remainingTickets } from "#booking/remaining-tickets.ts";
import { deriveDoorCacheKey } from "#crypto/hashing.ts";
import { toBase64Url } from "#crypto/utils.ts";
import { logActivity } from "#db/activity-log.ts";
import {
  type DecryptedAttendeeRow,
  decryptAttendees,
} from "#db/attendees/pii.ts";
import { getGroupById } from "#db/groups.ts";
import { getAttendeesPageByListingIds } from "#db/listings/attendees.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { decryptUsername, getUserById } from "#db/users.ts";
import { chunk, groupToMap, mapParallel, requiredMapValue, sumOf } from "#fp";
import { sortedByString } from "#fp-strings";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { type AuthSession, SCANNER_JSON, withAuth } from "#routes/auth.ts";
import type { IdRouteHandler } from "#routes/entity.ts";
import { jsonResponse, notFoundResponse } from "#routes/response.ts";
import { requireValue } from "#shared/required-value.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { hmacHex, importHmacKey } from "#shared/sha256.ts";
import { parseNonNegativeInt } from "#shared/validation/number.ts";
import { type Attendee, type Group, hasTicketQuantity } from "#types";
import { groupScope, listingScope, type ScanScope } from "./scan-answer.ts";
import { owingListings, scanAdmits } from "./scan-decision.ts";

/** The name a door's cache key derives from: the door's kind and id. The
 * cache endpoint and the scanner page derive the same key from the same
 * name. */
export const doorCacheName = (kind: "group" | "listing", id: number): string =>
  `${kind}:${id}`;

/** The door's cache key as the scanner page carries it: base64url bytes the
 * device decodes before it digests a scan. The page is the only response
 * that holds a door's key, so a copied cache response alone digests
 * nothing. */
export const pageDoorCacheKey = (door: string): string =>
  toBase64Url(deriveDoorCacheKey(door));

/** The token digests one round signs at once, so a large door's cache
 * build does not start every digest at the same time. */
const DIGEST_BATCH = 100;

/** How many people one cache page reads. One page is one bounded request,
 * so a door with thousands of people never decrypts them all at once. */
const CACHE_PAGE_PEOPLE = 250;

/** One saved ticket's keyed digest and the places one scan at this door
 * admits of its booking. The offline quantity ask reads the count and
 * bounds its pick at it. The server answers what the booking can still
 * supply when the check-in lands. */
export type TicketCacheEntry = { hash: string; tickets: number };

/** One page of a door's cache. `next` is the cursor for the next page, or
 * null on the last page. `people` counts the door's people this page read,
 * out of `total`. */
type TicketCachePage = {
  entries: TicketCacheEntry[];
  next: number | null;
  people: number;
  total: number;
};

/** One page of the keyed digests of one door's admittable ticket tokens,
 * read after the attendee id `afterId`. Each entry carries the
 * places one scan at this door admits of the token's booking. A token
 * belongs in the list when its attendee holds at least one line on the
 * door's listings that still owes a ticket. That line must not be refunded,
 * must carry ticket quantity, and is what a scan admits. Every token the
 * loaded lines carry joins the list. One token resolves the attendee's whole
 * booking. So any of the person's tickets admits them at this door the same
 * way, and each carries the same count. */
const ticketCachePage = async (
  scope: ScanScope,
  doorKey: Uint8Array,
  afterId: number,
): Promise<TicketCachePage> => {
  // Booking order — the (start, listing) order the scan's own decision
  // groups a booking's lines by — so the count names what that scan admits.
  const page = await getAttendeesPageByListingIds(
    [...scope.listingIds],
    afterId,
    CACHE_PAGE_PEOPLE,
    "start_then_listing",
  );
  const rows = await decryptAttendees(
    page.attendees,
    await requireRequestPrivateKey(),
  );
  const rowsByAttendee = groupToMap(
    (row: DecryptedAttendeeRow<Attendee>) => row.id,
    (row: DecryptedAttendeeRow<Attendee>) => row,
  )(rows);
  const owedByToken = new Map<string, number>();
  for (const lines of rowsByAttendee.values()) {
    // One line that can still admit admits the person, so any of the
    // person's tickets at this door goes in the list.
    const live = lines.filter((row) => !row.refunded && hasTicketQuantity(row));
    // The scan groups every line it can see before it drops the listings
    // that owe nothing. The count therefore names the listing that scan
    // lands on, even when an earlier line on it sits fully checked in.
    const owed = owingListings(live, (row) => row.listing_id, remainingTickets);
    if (owed.length === 0) continue;
    // What one scan admits, by the scan's own rule: the first listing
    // still owing places, or every one when this door checks them all in.
    const admitted = scanAdmits(false, scope.checkInEveryListing, owed);
    const places = sumOf(
      (owedLines: readonly DecryptedAttendeeRow<Attendee>[]) =>
        sumOf(remainingTickets)(owedLines),
    )(admitted);
    for (const row of lines) owedByToken.set(row.ticket_token, places);
  }
  // One key import serves every digest. A per-digest import repeats the
  // same work for each token. Each batch pairs its digests with the owed
  // counts, so no result order matters.
  const key = await importHmacKey(doorKey);
  const digestBatch = async (batch: string[]): Promise<TicketCacheEntry[]> =>
    Promise.all(
      batch.map(async (token) => ({
        hash: await hmacHex(key, token),
        tickets: requiredMapValue(owedByToken, token),
      })),
    );
  const entries = (
    await mapParallel(digestBatch)(chunk(DIGEST_BATCH)([...owedByToken.keys()]))
  ).flat();
  return {
    // Digest order, so every device saves the same list for the same door
    // and the same tokens.
    entries: sortedByString((entry: TicketCacheEntry) => entry.hash)(entries),
    next: page.nextAfter,
    people: page.people,
    total: page.total,
  };
};

/** One door as its cache routes see it. `door` is the name its key derives
 * from. `name` is the door's own name for the activity log. `listingId` is
 * the listing the log entry belongs to, or null for a group door. */
type CacheDoor = {
  door: string;
  listingId: number | null;
  name: string;
  scope: ScanScope;
};

/** Load one door by id. Null is the documented answer for a door that does
 * not exist, or a listing marked "No check-in". */
type CacheDoorLoader = (id: number) => Promise<CacheDoor | null>;

/** The attendee id a cache page starts after: absent means the first page. */
const cacheCursorOrNull = (request: Request): number | null => {
  const after = new URL(request.url).searchParams.get("after");
  return after === null ? 0 : parseNonNegativeInt(after);
};

/** One route at one door. It loads the door by id and hands it to
 * `answer`. A door that does not exist answers 404. */
const doorRoute =
  (
    answer: (
      door: CacheDoor,
      request: Request,
      session: AuthSession,
    ) => Promise<Response>,
  ) =>
  (load: CacheDoorLoader): IdRouteHandler =>
  (request, { id }) =>
    withAuth(request, SCANNER_JSON, async (session) => {
      const loaded = await load(id);
      return loaded ? answer(loaded, request, session) : notFoundResponse();
    });

/** One page of the door's digest set, after the cursor the request names. */
const handleScanCacheGet = doorRoute(async (loaded, request) => {
  const afterId = cacheCursorOrNull(request);
  if (afterId === null) return apiErrorResponse("Invalid page cursor");
  return jsonResponse(
    await ticketCachePage(
      loaded.scope,
      deriveDoorCacheKey(loaded.door),
      afterId,
    ),
  );
});

/** Record that one person turned offline mode on at one door. The scanner
 * page posts this before it downloads the door's list, so every download a
 * person starts has its log entry. */
const handleScanOfflinePost = doorRoute(async (loaded, _request, session) => {
  const username = await decryptUsername(
    requireValue(
      await getUserById(session.userId),
      `User ${session.userId} does not exist`,
    ),
  );
  await logActivity(
    `Offline scanning turned on for '${loaded.name}' by '${username}'`,
    loaded.listingId,
  );
  return jsonResponse({ status: "ok" });
});

/** The listing door. A "No check-in" listing has no door, so a guessed URL
 * meets the same answer as an unknown listing. */
const loadListingDoor: CacheDoorLoader = async (id) => {
  const listing = await getListingWithCount(id);
  return !listing || listing.purchaseOnly
    ? null
    : {
        door: doorCacheName("listing", id),
        listingId: id,
        name: listing.name,
        scope: listingScope(id),
      };
};

/** The group door. A missing group answers 404 rather than an empty set, so
 * a broken link cannot pass every ticket off as absent. */
const loadGroupDoor: CacheDoorLoader = async (id) => {
  const group: Group | null = await getGroupById(id);
  return group
    ? {
        door: doorCacheName("group", id),
        listingId: null,
        name: group.name,
        scope: await groupScope(group),
      }
    : null;
};

/** The offline routes of both door kinds: one page of the door's list, and
 * the record of a person turning offline mode on. */
export const offlineDoorRoutes = {
  "GET /admin/groups/:id/scan-cache": handleScanCacheGet(loadGroupDoor),
  "GET /admin/listing/:id/scan-cache": handleScanCacheGet(loadListingDoor),
  "POST /admin/groups/:id/scan-offline": handleScanOfflinePost(loadGroupDoor),
  "POST /admin/listing/:id/scan-offline":
    handleScanOfflinePost(loadListingDoor),
};
