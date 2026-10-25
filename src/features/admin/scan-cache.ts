/** The offline scan cache one door serves: keyed digests of the ticket
 * tokens its door can currently admit. Each digest is HMAC-SHA256 under a
 * key only the door's scanner page carries. A copied cache response alone
 * digests nothing. The scanner page stores the list on load, so a scan
 * with no connection answers from the digests alone. The offline quantity
 * ask bounds its pick at the stored count. The device never holds
 * the tokens of tickets it has not scanned, and never holds any guest
 * detail from this endpoint. */

/* jscpd:ignore-start -- imports */
import { remainingTickets } from "#booking/remaining-tickets.ts";
import { deriveDoorCacheKey } from "#crypto/hashing.ts";
import { toBase64Url } from "#crypto/utils.ts";
import type { DecryptedAttendeeRow } from "#db/attendees/pii.ts";
import { getGroupById } from "#db/groups.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { chunk, groupToMap, mapParallel, requiredMapValue, sumOf } from "#fp";
import { SCANNER_JSON, withAuth } from "#routes/auth.ts";
import type { IdRouteHandler } from "#routes/entity.ts";
import { jsonResponse, notFoundResponse } from "#routes/response.ts";
import { hmacHex, importHmacKey } from "#shared/sha256.ts";
import { type Attendee, type Group, hasTicketQuantity } from "#types";
import {
  groupScope,
  listingScope,
  type ScanScope,
  scopeAttendees,
} from "./scan-answer.ts";
import { owingListings, scanAdmits } from "./scan-decision.ts";
/* jscpd:ignore-end */

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

/** One saved ticket's keyed digest and the places one scan at this door
 * admits of its booking. The offline quantity ask reads the count and
 * bounds its pick at it. The server answers what the booking can still
 * supply when the check-in lands. */
export type TicketCacheEntry = { hash: string; tickets: number };

/** Puts one door's cache rows in digest order, so every device saves the
 * same list for the same door and the same tokens. */
const byDigest = (one: TicketCacheEntry, two: TicketCacheEntry): number => {
  if (one.hash < two.hash) return -1;
  return 1;
};

/** The keyed digests of one door's admittable ticket tokens, each with the
 * places one scan at this door admits of the token's booking. A token
 * belongs in the list when its attendee holds at least one line on the
 * door's listings that still owes a ticket. That line must not be refunded,
 * must carry ticket quantity, and is what a scan admits. Every token the
 * loaded lines carry joins the list. One token resolves the attendee's whole
 * booking. So any of the person's tickets admits them at this door the same
 * way, and each carries the same count. */
export const ticketCacheForScope = async (
  scope: ScanScope,
  doorKey: Uint8Array,
): Promise<TicketCacheEntry[]> => {
  // Booking order — the (start, listing) order the scan's own decision
  // groups a booking's lines by — so the count names what that scan admits.
  const rows = await scopeAttendees(scope, "start_then_listing");
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
        tickets: requiredMapValue(
          owedByToken,
          token,
          "A digested token lost its owed count",
        ),
      })),
    );
  const entries = (
    await mapParallel(digestBatch)(chunk(DIGEST_BATCH)([...owedByToken.keys()]))
  ).flat();
  return entries.sort(byDigest);
};

/** The cache response behind one door: the door's digest set, or the
 * not-found answer for a door that does not exist. */
const handleScanCacheGet =
  (
    load: (id: number) => Promise<{ door: string; scope: ScanScope } | null>,
  ): IdRouteHandler =>
  (request, { id }) =>
    withAuth(request, SCANNER_JSON, async () => {
      const loaded = await load(id);
      if (!loaded) return notFoundResponse();
      const doorKey = deriveDoorCacheKey(loaded.door);
      return jsonResponse({
        entries: await ticketCacheForScope(loaded.scope, doorKey),
      });
    });

/** Handle GET /admin/listing/:id/scan-cache — the listing door's digest set.
 * A "No check-in" listing has no door, so a guessed URL meets the same
 * answer as an unknown listing. */
export const handleListingScanCacheGet = handleScanCacheGet(async (id) => {
  const listing = await getListingWithCount(id);
  return !listing || listing.purchase_only
    ? null
    : { door: doorCacheName("listing", id), scope: listingScope(id) };
});

/** Handle GET /admin/groups/:id/scan-cache — the group door's digest set. A
 * missing group answers 404 rather than an empty set, so a broken link
 * cannot pass every ticket off as absent. */
export const handleGroupScanCacheGet = handleScanCacheGet(async (id) => {
  const group: Group | null = await getGroupById(id);
  return group
    ? { door: doorCacheName("group", id), scope: await groupScope(group) }
    : null;
});
