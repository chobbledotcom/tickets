/** The offline scan cache one door serves: SHA-256 hashes of the ticket
 * tokens its door can currently admit. The scanner page stores the set on
 * load, so a scan with no connection answers from the hashes alone. The
 * device never holds the tokens of tickets it has not scanned, and never
 * holds any guest detail from this endpoint. */

/* jscpd:ignore-start -- imports */
import { remainingTickets } from "#booking/remaining-tickets.ts";
import type { DecryptedAttendeeRow } from "#db/attendees/pii.ts";
import { getGroupById } from "#db/groups.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { groupToMap } from "#fp";
import { SCANNER_JSON, withAuth } from "#routes/auth.ts";
import type { IdRouteHandler } from "#routes/entity.ts";
import { jsonResponse, notFoundResponse } from "#routes/response.ts";
import { sha256Hex } from "#shared/sha256.ts";
import { type Attendee, type Group, hasTicketQuantity } from "#types";
import {
  groupScope,
  listingScope,
  type ScanScope,
  scopeAttendees,
} from "./scan-answer.ts";
/* jscpd:ignore-end */

/** The hashes of one door's admittable ticket tokens. A token belongs in the
 * set when its attendee holds at least one line on the door's listings that
 * still owes a ticket. That line must not be refunded, must carry ticket
 * quantity, and is what a scan admits. Every token the loaded lines carry
 * joins the set. One token resolves the attendee's whole booking. So any of
 * the person's tickets admits them at this door the same way. */
export const ticketHashesForScope = async (
  scope: ScanScope,
): Promise<string[]> => {
  const rows = await scopeAttendees(scope);
  const rowsByAttendee = groupToMap(
    (row: DecryptedAttendeeRow<Attendee>) => row.id,
    (row: DecryptedAttendeeRow<Attendee>) => row,
  )(rows);
  const hashes: string[] = [];
  for (const lines of rowsByAttendee.values()) {
    // One line that can still admit admits the person, so any of the
    // person's tickets at this door goes in the set.
    const owes = lines.some(
      (row) =>
        remainingTickets(row) > 0 && !row.refunded && hasTicketQuantity(row),
    );
    if (!owes) continue;
    for (const row of lines) hashes.push(await sha256Hex(row.ticket_token));
  }
  return [...new Set(hashes)].sort();
};

/** The cache response behind one door: the door's hash set, or the not-found
 * answer for a door that does not exist. */
const handleScanCacheGet =
  (load: (id: number) => Promise<ScanScope | null>): IdRouteHandler =>
  (request, { id }) =>
    withAuth(request, SCANNER_JSON, async () => {
      const scope = await load(id);
      if (!scope) return notFoundResponse();
      return jsonResponse({
        hashes: await ticketHashesForScope(scope),
      });
    });

/** Handle GET /admin/listing/:id/scan-cache — the listing door's hash set. A
 * "No check-in" listing has no door, so a guessed URL meets the same answer
 * as an unknown listing. */
export const handleListingScanCacheGet = handleScanCacheGet(async (id) => {
  const listing = await getListingWithCount(id);
  return !listing || listing.purchase_only ? null : listingScope(id);
});

/** Handle GET /admin/groups/:id/scan-cache — the group door's hash set. A
 * missing group answers 404 rather than an empty set, so a broken link
 * cannot pass every ticket off as absent. */
export const handleGroupScanCacheGet = handleScanCacheGet(async (id) => {
  const group: Group | null = await getGroupById(id);
  return group ? await groupScope(group) : null;
});
