/**
 * The scanner's offline ticket list: the ticket tokens of one door's scope,
 * answered as SHA-256 digests for the scanner page to save on load. The
 * device caches digests only. It never caches the token itself or a guest
 * detail. A read of the device's storage hands over nothing that opens a
 * door. The list travels under the scan API's own auth. The same door roles
 * guard it, and it serves only the door the session works.
 */

import { sha256Hex } from "#crypto/sha256.ts";
import type { DecryptedAttendeeRow } from "#db/attendees/pii.ts";
import { getGroupById } from "#db/groups.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { unique } from "#fp";
import { SCANNER_JSON, withAuth } from "#routes/auth.ts";
import type { IdRouteHandler } from "#routes/entity.ts";
import { jsonResponse } from "#routes/response.ts";
import { type Attendee, type Group, hasTicketQuantity } from "#types";
import {
  doorAttendees,
  groupScope,
  scanNotFoundResponse,
  scannerPrivateKey,
} from "./scan-answer.ts";

/** The lines a saved list may stand for: a line the door's own scan admits
 * or counts as used. A refunded order and a no-quantity line both turn a
 * scan away online, so a digest that stands for only those would answer
 * "looks legit" offline for a ticket the door refuses. A line still owing
 * nothing stays: the door's own scan answers "already checked in" for it,
 * and that is the answer a replayed delivery must fetch home. */
const cacheWorthyTokens = (
  attendees: readonly DecryptedAttendeeRow<Attendee>[],
): string[] =>
  unique(
    attendees
      .filter((line) => hasTicketQuantity(line) && !line.refunded)
      .map((line) => line.ticket_token),
  );

/** Answer the door's token list: every eligible attendee of the scope's
 * listings, decrypted, each token answered only as its SHA-256 digest. The
 * list is sorted, so the same door always answers the same list. */
const tokenListResponse = async (
  listingIds: readonly number[],
): Promise<Response> => {
  const privateKey = await scannerPrivateKey();
  if (privateKey instanceof Response) return privateKey;
  const attendees = await doorAttendees(listingIds, privateKey);
  const hashes = await Promise.all(cacheWorthyTokens(attendees).map(sha256Hex));
  return jsonResponse({ hashes: hashes.sort() });
};

/** One authed GET of a door's token list: the scan API's guard runs, then
 * the door resolves its scope, or the scan API's not-found answers. */
const scanTokensGet =
  (findListingIds: (id: number) => Promise<number[] | null>): IdRouteHandler =>
  (request, { id }) =>
    withAuth(request, SCANNER_JSON, async () => {
      const listingIds = await findListingIds(id);
      if (listingIds === null) return scanNotFoundResponse();
      return tokenListResponse(listingIds);
    });

export const handleListingScanTokensGet: IdRouteHandler = scanTokensGet(
  async (id) => {
    const listing = await getListingWithCount(id);
    // A "No check-in" listing has no door: its tokens do not travel either.
    return listing && !listing.purchase_only ? [listing.id] : null;
  },
);

export const handleGroupScanTokensGet: IdRouteHandler = scanTokensGet(
  async (id) => {
    const group: Group | null = await getGroupById(id);
    return group ? [...(await groupScope(group)).listingIds] : null;
  },
);
