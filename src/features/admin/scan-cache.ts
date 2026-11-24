/** The offline scan cache one door serves: keyed digests of the ticket
 * tokens its door can currently admit. Each digest is HMAC-SHA256 under a
 * key only the door's scanner page carries. A copied cache response alone
 * digests nothing. The scanner page downloads the list in pages when the door
 * turns offline mode on. A scan with no connection then answers from the
 * digests alone. The offline quantity ask bounds its pick at the stored
 * count. The device never holds the tokens of tickets it has not scanned.
 * Each entry names its person and the door-safe details, so the manual
 * check-in can find them by name with no connection. */

import { remainingTickets } from "#booking/remaining-tickets.ts";
import {
  defineSignedToken,
  type IdPayload,
  parseIdPayload,
} from "#crypto/define-signed-token.ts";
import { deriveDoorCacheKey } from "#crypto/hashing.ts";
import { logActivity } from "#db/activity-log.ts";
import {
  type DecryptedAttendeeRow,
  decryptAttendees,
} from "#db/attendees/pii.ts";
import { getAttendeesPageByListingIds } from "#db/listings/attendees.ts";
import { decryptUsername, getUserById } from "#db/users.ts";
import { chunk, groupToMap, mapParallel, requiredMapValue, sumOf } from "#fp";
import { sortedByString } from "#fp-strings";
import { apiErrorResponse } from "#routes/api/cors.ts";
import type { AuthSession } from "#routes/auth.ts";
import { jsonResponse } from "#routes/response.ts";
import { expiresIn } from "#shared/now.ts";
import { requireValue } from "#shared/required-value.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { hmacHex, importHmacKey } from "#shared/sha256.ts";
import { type Attendee, hasTicketQuantity } from "#types";
import type { ScanScope } from "./scan-answer.ts";
import { owingListings, scanAdmits } from "./scan-decision.ts";
import {
  doorListingNames,
  doorRoute,
  type ListingNames,
  lineOwes,
  loadGroupDoor,
  loadListingDoor,
  optionDetails,
  type ScanDoor,
} from "./scan-door.ts";

/** The token digests one round signs at once, so a large door's cache
 * build does not start every digest at the same time. */
const DIGEST_BATCH = 100;

/** How many people one cache page reads. One page is one bounded request,
 * so a door with thousands of people never decrypts them all at once. */
const CACHE_PAGE_PEOPLE = 250;

/** One saved ticket's keyed digest and the places one scan at this door
 * admits of its booking. The offline quantity ask reads the count and
 * bounds its pick at it. The server answers what the booking can still
 * supply when the check-in lands. The person's name and the door-safe
 * details let the door find them by name with no connection. */
export type TicketCacheEntry = {
  details: string[];
  hash: string;
  name: string;
  tickets: number;
};

/** What one token's entry says about its person, before the digest. */
type EntryFacts = Omit<TicketCacheEntry, "hash">;

/** One page of a door's cache. `next` is the signed cursor for the next
 * page, or null on the last page. `people` counts the door's people this
 * page read, out of `total`. */
type TicketCachePage = {
  entries: TicketCacheEntry[];
  next: string | null;
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
  listingNames: ListingNames,
  doorKey: Uint8Array,
  afterId: number,
  cursorAfter: (attendeeId: number) => Promise<string>,
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
  const factsByToken = new Map<string, EntryFacts>();
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
    const facts = {
      details: optionDetails(lines.filter(lineOwes), listingNames),
      name: lines[0]!.name,
      tickets: places,
    };
    for (const row of lines) factsByToken.set(row.ticket_token, facts);
  }
  // One key import serves every digest. A per-digest import repeats the
  // same work for each token. Each batch pairs its digests with the owed
  // counts, so no result order matters.
  const key = await importHmacKey(doorKey);
  const digestBatch = async (batch: string[]): Promise<TicketCacheEntry[]> =>
    Promise.all(
      batch.map(async (token) => ({
        ...requiredMapValue(factsByToken, token),
        hash: await hmacHex(key, token),
      })),
    );
  const entries = (
    await mapParallel(digestBatch)(
      chunk(DIGEST_BATCH)([...factsByToken.keys()]),
    )
  ).flat();
  return {
    // Digest order, so every device saves the same list for the same door
    // and the same tokens.
    entries: sortedByString((entry: TicketCacheEntry) => entry.hash)(entries),
    next: page.nextAfter === null ? null : await cursorAfter(page.nextAfter),
    people: page.people,
    total: page.total,
  };
};

/** How long one page's cursor stays valid. A download that stops for longer
 * starts again from the first page, which logs again. */
const CURSOR_MAX_AGE_S = 60 * 60;

/** Who a cursor belongs to. Its HMAC binds it to one door and one user.
 * Nobody can read later pages on a cursor from another person's first page. */
type CursorOwner = { door: string; userId: number };

/** A cache page cursor: `a` is the last attendee id its page read. */
const cacheCursor = defineSignedToken<IdPayload, CursorOwner>({
  maxAgeS: CURSOR_MAX_AGE_S,
  message: ({ door, userId }, encoded) =>
    `scan-cache-cursor:${door}:${userId}:${encoded}`,
  parse: parseIdPayload,
  prefix: "sc1.",
});

/** Write the log entry for one person who starts to download a door's list. */
const logListDownload = async (
  loaded: ScanDoor,
  session: AuthSession,
): Promise<void> => {
  const username = await decryptUsername(
    requireValue(
      await getUserById(session.userId),
      `User ${session.userId} does not exist`,
    ),
  );
  await logActivity(
    `Offline ticket list downloaded for '${loaded.name}' by '${username}'`,
    loaded.listingId,
  );
};

/** One page of the door's digest set. A request with no `from` is the first
 * page, and it writes the activity log entry. Every later page needs the
 * signed cursor that the page before it issued, so no page reaches a device
 * without a logged first page. */
const handleScanCacheGet = doorRoute(async (loaded, request, session) => {
  const owner = { door: loaded.door, userId: session.userId };
  const from = new URL(request.url).searchParams.get("from");
  const cursor =
    from === null ? { a: 0 } : await cacheCursor.verify(owner, from);
  if (cursor === null) return apiErrorResponse("Invalid page cursor");
  if (from === null) await logListDownload(loaded, session);
  return jsonResponse(
    await ticketCachePage(
      loaded.scope,
      await doorListingNames(loaded.scope),
      deriveDoorCacheKey(loaded.door),
      cursor.a,
      (attendeeId) =>
        cacheCursor.sign(owner, {
          a: attendeeId,
          e: expiresIn(CURSOR_MAX_AGE_S),
        }),
    ),
  );
});

/** The cache routes of both door kinds: one page of the door's list. */
export const scanCacheRoutes = {
  "GET /admin/groups/:id/scan-cache": handleScanCacheGet(loadGroupDoor),
  "GET /admin/listing/:id/scan-cache": handleScanCacheGet(loadListingDoor),
};
