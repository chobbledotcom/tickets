/**
 * QR scanner routes for admin check-in
 * GET /admin/scanner - The doors list a scanner login lands on
 * GET /admin/listing/:id/scanner - Scanner page with camera UI
 * POST /admin/listing/:id/scan - JSON API for processing scanned tokens
 * GET /admin/groups/:id/scanner - One scanner for every member of a group
 * POST /admin/groups/:id/scan - The same JSON API over the group's members
 */

import { decryptAttendees } from "#db/attendees/pii.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { getAllGroupNames, getGroupById } from "#db/groups.ts";
import { getAttendeesByListingIds } from "#db/listings/attendees.ts";
import { getListingPickerNames } from "#db/listings/catalog.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { filter, groupToMap, reduce } from "#fp";
import { sortedByString } from "#fp-strings";
import { pageGuardFor, SCANNER_JSON, withAuth } from "#routes/auth.ts";
import { createIdEntityHandler, type IdRouteHandler } from "#routes/entity.ts";
import {
  htmlResponse,
  jsonResponse,
  notFoundResponse,
} from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { adminDestination } from "#shared/admin-surface.ts";
import { formatDateLabel } from "#shared/dates.ts";
import type { RequestRoute } from "#shared/response-steps.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import {
  adminScannerDoorsPage,
  adminScannerPage,
  type ScannerDoor,
  type TicketOption,
} from "#templates/admin/scanner.tsx";
import { type Attendee, type Group, hasTicketQuantity } from "#types";
import { groupScope, listingScope, processScan } from "./scan-answer.ts";

/** The door-safe facts that tell two people with the same name apart: which
 * listing (on a door that spans several) and which day each of their places
 * is for — the same facts the ticket's own page shows a door-only login. */
const optionDetails = (
  rows: readonly Attendee[],
  listingNames: ReadonlyMap<number, string> | null,
): string[] => [
  ...new Set(
    rows.map((row) =>
      [
        listingNames?.get(row.listing_id) ?? "",
        row.date ? formatDateLabel(row.date) : "",
      ]
        .filter(Boolean)
        .join(" · "),
    ),
  ),
];

const manualCheckinOptions = (
  attendees: Attendee[],
  listingNames: ReadonlyMap<number, string> | null,
): TicketOption[] =>
  [
    ...groupToMap(
      (a: Attendee) => a.id,
      (a: Attendee) => a,
    )(
      filter(
        (a: Attendee) => !a.checked_in && !a.refunded && hasTicketQuantity(a),
      )(attendees),
    ).values(),
  ].map((rows: Attendee[]) => ({
    attendeeId: rows[0]!.id,
    details: optionDetails(rows, listingNames),
    name: rows[0]!.name,
    quantity: reduce(
      (total: number, row: Attendee) => total + row.quantity,
      0,
    )(rows),
  }));

/** Handle GET /admin/listing/:id/scanner - render scanner page */
const handleScannerGet: IdRouteHandler = createIdEntityHandler<
  NonNullable<Awaited<ReturnType<typeof getListingWithCount>>>
>(getListingWithCount)(pageGuardFor(adminDestination("listingScanner")))(
  async (listing, session) => {
    // A "No check-in" listing has no door: the doors list hides it, and a
    // guessed URL meets the same answer as an unknown listing.
    if (listing.purchase_only) return notFoundResponse();
    const privateKey = await requireRequestPrivateKey();
    const attendees = await decryptAttendees(
      await getAttendeesRaw(listing.id),
      privateKey,
    );
    return htmlResponse(
      adminScannerPage(
        listing,
        `/admin/listing/${listing.id}/scan`,
        session,
        manualCheckinOptions(attendees, null),
      ),
    );
  },
);

/** Handle GET /admin/groups/:id/scanner - render the group scanner page */
const handleGroupScannerGet: IdRouteHandler = createIdEntityHandler<Group>(
  getGroupById,
)(pageGuardFor(adminDestination("groupScanner")))(async (group, session) => {
  const privateKey = await requireRequestPrivateKey();
  const scope = await groupScope(group);
  const attendees = await decryptAttendees(
    await getAttendeesByListingIds([...scope.listingIds]),
    privateKey,
  );
  // A door that spans several listings names the listing each place is for;
  // a one-listing door's own page title already says it.
  const listingNames =
    scope.listingIds.size > 1
      ? new Map(
          [...(await getListingPickerNames())]
            .filter(([id]) => scope.listingIds.has(id))
            .map(([id, listing]) => [id, listing.name] as const),
        )
      : null;
  return htmlResponse(
    adminScannerPage(
      group,
      `/admin/groups/${group.id}/scan`,
      session,
      manualCheckinOptions(attendees, listingNames),
      // One scan at this door spans listings only from a multi-listing
      // group whose stored rule says to check in every listing.
      scope.listingIds.size > 1 && scope.checkInEveryListing,
    ),
  );
});

/** Every door a scanner login can work: each listing that has a door (the
 * "No check-in" listings sell things with no door) and every group, both
 * ordered by name so tonight's door is easy to find. */
const loadDoors = async (): Promise<{
  groupDoors: ScannerDoor[];
  listingDoors: ScannerDoor[];
}> => {
  const [listings, groups] = await Promise.all([
    getListingPickerNames(),
    getAllGroupNames(),
  ]);
  const listingDoors = [...listings]
    .filter(([, listing]) => !listing.purchase_only)
    .map(
      ([id, listing]): ScannerDoor => ({
        name: listing.name,
        path: `/admin/listing/${id}/scanner`,
      }),
    );
  const groupDoors = [...groups].map(
    ([id, name]): ScannerDoor => ({
      name,
      path: `/admin/groups/${id}/scanner`,
    }),
  );
  return {
    groupDoors: sortedByString((door: ScannerDoor) => door.name)(groupDoors),
    listingDoors: sortedByString((door: ScannerDoor) => door.name)(
      listingDoors,
    ),
  };
};

/** Handle GET /admin/scanner - the doors list a scanner login lands on */
const handleDoorsGet: RequestRoute = (request) =>
  pageGuardFor(adminDestination("doors"))(request, async (session) =>
    htmlResponse(adminScannerDoorsPage(session, await loadDoors())),
  );

/**
 * Handle POST /admin/listing/:id/scan - JSON check-in API.
 * Scanner is intentionally one-way (check-in only, no check-out) to prevent
 * accidental check-outs from double-scans during rapid door check-in.
 */
const handleScanPost: IdRouteHandler = (request, { id }) =>
  withAuth(request, SCANNER_JSON, (_session, body) =>
    processScan(listingScope(id), body),
  );

/** Handle POST /admin/groups/:id/scan — the same API over the group's whole
 * scope. A missing group answers 404 rather than an empty scope, so a broken
 * link cannot pass every ticket off as "wrong listing". */
const handleGroupScanPost: IdRouteHandler = (request, { id }) =>
  withAuth(request, SCANNER_JSON, async (_session, body) => {
    const group = await getGroupById(id);
    if (!group) return jsonResponse({ status: "not_found" }, 404);
    return processScan(await groupScope(group), body);
  });

/** Scanner routes */
export const adminHandlers = defineRoutes({
  "GET /admin/groups/:id/scanner": handleGroupScannerGet,
  "GET /admin/listing/:id/scanner": handleScannerGet,
  "GET /admin/scanner": handleDoorsGet,
  "POST /admin/groups/:id/scan": handleGroupScanPost,
  "POST /admin/listing/:id/scan": handleScanPost,
});
