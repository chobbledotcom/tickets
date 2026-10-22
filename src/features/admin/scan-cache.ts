/** The offline scan cache one door serves: keyed digests of the ticket
 * tokens its door can currently admit. Each digest is HMAC-SHA256 under a
 * key only the door's scanner page carries, so a copied cache response
 * alone digests nothing. The scanner page stores the set on load, so a scan
 * with no connection answers from the digests alone. The device never holds
 * the tokens of tickets it has not scanned, and never holds any guest
 * detail from this endpoint. */

/* jscpd:ignore-start -- imports */
import { remainingTickets } from "#booking/remaining-tickets.ts";
import { deriveDoorCacheKey } from "#crypto/hashing.ts";
import { toBase64Url } from "#crypto/utils.ts";
import type { DecryptedAttendeeRow } from "#db/attendees/pii.ts";
import { getGroupById } from "#db/groups.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { chunk, groupToMap, mapParallel } from "#fp";
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

/** The keyed digests of one door's admittable ticket tokens. A token belongs
 * in the set when its attendee holds at least one line on the door's
 * listings that still owes a ticket. That line must not be refunded, must
 * carry ticket quantity, and is what a scan admits. Every token the loaded
 * lines carry joins the set. One token resolves the attendee's whole
 * booking. So any of the person's tickets admits them at this door the same
 * way. */
export const ticketHashesForScope = async (
  scope: ScanScope,
  doorKey: Uint8Array,
): Promise<string[]> => {
  const rows = await scopeAttendees(scope);
  const rowsByAttendee = groupToMap(
    (row: DecryptedAttendeeRow<Attendee>) => row.id,
    (row: DecryptedAttendeeRow<Attendee>) => row,
  )(rows);
  const tokens: string[] = [];
  for (const lines of rowsByAttendee.values()) {
    // One line that can still admit admits the person, so any of the
    // person's tickets at this door goes in the set.
    const owes = lines.some(
      (row) =>
        remainingTickets(row) > 0 && !row.refunded && hasTicketQuantity(row),
    );
    if (!owes) continue;
    for (const row of lines) tokens.push(row.ticket_token);
  }
  // One key import serves every digest. A per-digest import repeats the
  // same work for each token.
  const key = await importHmacKey(doorKey);
  const digestBatch = (batch: string[]): Promise<string[]> =>
    Promise.all(batch.map((token) => hmacHex(key, token)));
  const digests = (
    await mapParallel(digestBatch)(chunk(DIGEST_BATCH)(tokens))
  ).flat();
  return [...new Set(digests)].sort();
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
        hashes: await ticketHashesForScope(loaded.scope, doorKey),
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
