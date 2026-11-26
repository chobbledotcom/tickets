/** The offline scan cache one door serves: keyed digests of the ticket
 * tokens its door can currently admit. Each digest is HMAC-SHA256 under a
 * key only the door's scanner page carries. A copied cache response alone
 * digests nothing. The scanner page downloads the list in pages when the door
 * turns offline mode on. A scan with no connection then answers from the
 * digests alone. The offline quantity ask bounds its pick at the stored
 * count. The device never holds the tokens of tickets it has not scanned.
 * Each entry names its person and the door-safe details, so the manual
 * check-in can find them by name with no connection. */

import * as v from "valibot";
import {
  defineSignedToken,
  type ExpiringPayload,
} from "#crypto/define-signed-token.ts";
import { deriveDoorCacheKey } from "#crypto/hashing.ts";
import { logActivity } from "#db/activity-log.ts";
import {
  type DecryptedAttendeeRow,
  decryptAttendees,
} from "#db/attendees/pii.ts";
import { getAttendeesPageByListingIds } from "#db/listings/attendees.ts";
import { decryptUsername, getUserById } from "#db/users.ts";
import { chunk, flatMap, groupToMap, mapParallel } from "#fp";
import { sortedByString } from "#fp-strings";
import { apiErrorResponse } from "#routes/api/cors.ts";
import type { AuthSession } from "#routes/auth.ts";
import { jsonResponse } from "#routes/response.ts";
import { expiresIn } from "#shared/now.ts";
import { requireValue } from "#shared/required-value.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { hmacHex, importHmacKey } from "#shared/sha256.ts";
import type {
  TicketCacheEntry,
  TicketCachePageSchema,
} from "#shared/ticket-cache.ts";
import { parseOrNull } from "#shared/validation/parse.ts";
import type { Attendee } from "#types";
import type { ScanScope } from "./scan-answer.ts";
import {
  doorListingNames,
  doorRoute,
  type ListingNames,
  loadGroupDoor,
  loadListingDoor,
  personFacts,
  type ScanDoor,
} from "./scan-door.ts";

/** The token digests one round signs at once, so a large door's cache
 * build does not start every digest at the same time. */
const DIGEST_BATCH = 100;

/** How many people one cache page reads. One page is one bounded request,
 * so a door with thousands of people never decrypts them all at once. */
const CACHE_PAGE_PEOPLE = 250;

/** What one token's entry says about its person, before the digest. */
type EntryFacts = Omit<TicketCacheEntry, "hash">;

/** One person's booking lines on the door's listings. */
type PersonLines = DecryptedAttendeeRow<Attendee>[];

/** Each of one person's tokens, paired with the person's facts. A person
 * the door owes nothing brings no token. The facts are the door's own
 * rule, shared with the name search, so one number means one thing. */
const tokenFacts =
  (checkInEveryListing: boolean, listingNames: ListingNames) =>
  (lines: PersonLines): [string, EntryFacts][] => {
    const facts = personFacts(lines, checkInEveryListing, listingNames);
    return facts === null
      ? []
      : lines.map((row): [string, EntryFacts] => [row.ticket_token, facts]);
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
  lineMark: number | null,
  cursorAfter: (attendeeId: number, lineMark: number) => Promise<string>,
): Promise<v.InferOutput<typeof TicketCachePageSchema>> => {
  // Booking order — the (start, listing) order the scan's own decision
  // groups a booking's lines by — so the count names what that scan admits.
  const page = await getAttendeesPageByListingIds(
    [...scope.listingIds],
    afterId,
    CACHE_PAGE_PEOPLE,
    "start_then_listing",
    lineMark,
  );
  const rows = await decryptAttendees(
    page.attendees,
    await requireRequestPrivateKey(),
  );
  const rowsByAttendee = groupToMap(
    (row: DecryptedAttendeeRow<Attendee>) => row.id,
    (row: DecryptedAttendeeRow<Attendee>) => row,
  )(rows);
  // One token resolves the whole booking, so a token two lines share is
  // one entry.
  const factsByToken = new Map(
    flatMap(tokenFacts(scope.checkInEveryListing, listingNames))([
      ...rowsByAttendee.values(),
    ]),
  );
  // One key import serves every digest. A per-digest import repeats the
  // same work for each token. Each digest travels with its own facts, so no
  // result order matters.
  const key = await importHmacKey(doorKey);
  const digestBatch = (
    batch: [string, EntryFacts][],
  ): Promise<TicketCacheEntry[]> =>
    mapParallel(async ([token, facts]: [string, EntryFacts]) => ({
      ...facts,
      hash: await hmacHex(key, token),
    }))(batch);
  const entries = (
    await mapParallel(digestBatch)(chunk(DIGEST_BATCH)([...factsByToken]))
  ).flat();
  return {
    // Digest order, so every device saves the same list for the same door
    // and the same tokens.
    entries: sortedByString((entry: TicketCacheEntry) => entry.hash)(entries),
    next:
      page.nextAfter === null
        ? null
        : await cursorAfter(page.nextAfter, page.lineMark),
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

/** A cache page cursor's payload: `a` is the last attendee id its page read,
 * `m` is the line-id watermark the first page captured, and `e` is the
 * expiry every signed payload carries. */
type CursorPayload = ExpiringPayload & { a: number; m: number };

const CursorPayloadSchema = v.strictObject({
  a: v.number(),
  e: v.number(),
  m: v.number(),
});

/** The shape check of a cursor payload, for the scheme's `parse`. The HMAC
 * check runs before it, so only a payload this server signed reaches it. */
const parseCursorPayload = (
  raw: Record<string, unknown>,
): CursorPayload | null => parseOrNull(CursorPayloadSchema, raw);

/** A cache page cursor. */
const cacheCursor = defineSignedToken<CursorPayload, CursorOwner>({
  maxAgeS: CURSOR_MAX_AGE_S,
  message: ({ door, userId }, encoded) =>
    `scan-cache-cursor:${door}:${userId}:${encoded}`,
  parse: parseCursorPayload,
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
    `Offline ticket list download started for '${loaded.name}' by '${username}'`,
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
    from === null ? { a: 0, m: null } : await cacheCursor.verify(owner, from);
  if (cursor === null) return apiErrorResponse("Invalid page cursor");
  if (from === null) await logListDownload(loaded, session);
  return jsonResponse(
    await ticketCachePage(
      loaded.scope,
      await doorListingNames(loaded.scope),
      deriveDoorCacheKey(loaded.door),
      cursor.a,
      cursor.m,
      (attendeeId, mark) =>
        cacheCursor.sign(owner, {
          a: attendeeId,
          e: expiresIn(CURSOR_MAX_AGE_S),
          m: mark,
        }),
    ),
  );
});

/** The cache routes of both door kinds: one page of the door's list. */
export const scanCacheRoutes = {
  "GET /admin/groups/:id/scan-cache": handleScanCacheGet(loadGroupDoor),
  "GET /admin/listing/:id/scan-cache": handleScanCacheGet(loadListingDoor),
};
