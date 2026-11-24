import { getAllGroupNames, getGroupById } from "#db/groups.ts";
import { getListingPickerNames } from "#db/listings/catalog.ts";
import { PRUNE_SCAN_OPERATIONS_RETENTION_DAYS } from "#db/processed-scan-operations.ts";
import { sortedByString } from "#fp-strings";
import { defineAdminRoutes } from "#routes/admin/route-tables.ts";
import { pageGuardFor, SCANNER_JSON, withAuth } from "#routes/auth.ts";
import { createIdEntityHandler, type IdRouteHandler } from "#routes/entity.ts";
import {
  htmlResponse,
  jsonResponse,
  notFoundResponse,
} from "#routes/response.ts";
import { pageGuardAt } from "#routes/route-gates.ts";
import { adminDestination } from "#shared/admin-surface.ts";
import type { RequestRoute } from "#shared/response-steps.ts";
import {
  adminScannerDoorsPage,
  adminScannerPage,
  type ScannerDoor,
} from "#templates/admin/scanner.tsx";
import type { Group } from "#types";
import { listingWithCountHandler } from "./listing-entity.ts";
import { groupScope, listingScope, processScan } from "./scan-answer.ts";
import { scanCacheRoutes } from "./scan-cache.ts";
import { doorCacheName, loadGroupDoor, pageDoorCacheKey } from "./scan-door.ts";
import { scanSearchRoutes } from "./scan-search.ts";

/** Handle GET /admin/listing/:id/scanner - render scanner page */
const handleScannerGet: IdRouteHandler = listingWithCountHandler(
  pageGuardAt("listingScanner"),
)(async (listing, session) => {
  // A "No check-in" listing has no door: the doors list hides it, and a
  // guessed URL meets the same answer as an unknown listing.
  if (listing.purchaseOnly) return notFoundResponse();
  return htmlResponse(
    adminScannerPage(
      listing,
      `/admin/listing/${listing.id}/scan`,
      session,
      false,
      pageDoorCacheKey(doorCacheName("listing", listing.id)),
      PRUNE_SCAN_OPERATIONS_RETENTION_DAYS,
    ),
  );
});

/** Handle GET /admin/groups/:id/scanner - render the group scanner page */
const handleGroupScannerGet: IdRouteHandler = createIdEntityHandler<Group>(
  getGroupById,
)(pageGuardAt("groupScanner"))(async (group, session) => {
  const scope = await groupScope(group);
  return htmlResponse(
    adminScannerPage(
      group,
      `/admin/groups/${group.id}/scan`,
      session,
      // One scan at this door spans listings only from a multi-listing
      // group whose stored rule says to check in every listing.
      scope.listingIds.size > 1 && scope.checkInEveryListing,
      pageDoorCacheKey(doorCacheName("group", group.id)),
      PRUNE_SCAN_OPERATIONS_RETENTION_DAYS,
    ),
  );
});

/** Every door a scanner login can work: each listing that has a door (the
 * "No check-in" listings sell things with no door) and every group. Both are
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
    .filter(([, listing]) => !listing.purchaseOnly)
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
    processScan(listingScope(id), body, doorCacheName("listing", id)),
  );

/** Handle POST /admin/groups/:id/scan — the same API over the group's whole
 * scope. A missing group answers 404 rather than an empty scope, so a broken
 * link cannot pass every ticket off as "wrong listing". */
const handleGroupScanPost: IdRouteHandler = (request, { id }) =>
  withAuth(request, SCANNER_JSON, async (_session, body) => {
    const door = await loadGroupDoor(id);
    if (!door) return jsonResponse({ status: "not_found" }, 404);
    return processScan(door.scope, body, door.door);
  });

/** Scanner routes */
export const adminHandlers = defineAdminRoutes({
  ...scanCacheRoutes,
  ...scanSearchRoutes,
  "GET /admin/groups/:id/scanner": handleGroupScannerGet,
  "GET /admin/listing/:id/scanner": handleScannerGet,
  "GET /admin/scanner": handleDoorsGet,
  "POST /admin/groups/:id/scan": handleGroupScanPost,
  "POST /admin/listing/:id/scan": handleScanPost,
});
