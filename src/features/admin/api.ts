/**
 * Admin JSON API routes — accessible via API key or cookie+CSRF.
 *
 * These endpoints expose admin operations as JSON for programmatic access.
 * Authentication is handled by withAuth which accepts either:
 *   - Bearer token (API key) — no CSRF needed
 *   - Session cookie + x-csrf-token header
 */

import { listingGroups } from "#db/groups.ts";
import { syncListingPrices } from "#db/listing-prices.ts";
import {
  getAllListings,
  getListingWithCount,
  getListingWithCountPrimary,
  listingsTable,
} from "#db/listings/records.ts";
/* jscpd:ignore-start */
import { mapById } from "#fp";
import { groupApiRoutes } from "#routes/admin/api-groups.ts";
import { holidayApiRoutes } from "#routes/admin/api-holidays.ts";
import { verifyIdentifierOrJsonError } from "#routes/admin/confirmation.ts";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { jsonResponse } from "#routes/response.ts";
import type { RouteHandlerFn, RouteParams } from "#routes/router.ts";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import {
  deleteOrphanedAddOnError,
  performListingDelete,
  toggleListingActive,
  validateListingInput,
} from "#shared/listings-actions.ts";
import { defineCrudApi } from "#shared/rest/crud-api.ts";
import { type DeleteBody, withApiEntity } from "#shared/rest/crud-parsers.ts";
import type { AdminListing, Listing, ListingWithCount } from "#types";

import { bodyToCreateInput, bodyToUpdateInput } from "./api-listing-body.ts";
import {
  type PreparedListingJoins,
  persistListingJoins,
  prepareListingJoins,
} from "./api-listing-joins.ts";

/* jscpd:ignore-end */

/** JSON body accepted by DELETE /api/admin/listings/:listingId */
export type DeleteListingBody = DeleteBody;

// =============================================================================
// Custom routes (delete with cleanup, activate/deactivate)
// =============================================================================

const withListing = (
  request: Request,
  listingId: number,
  handler: (
    listing: ListingWithCount,
    body: Record<string, unknown>,
  ) => Promise<Response>,
): Promise<Response> =>
  withApiEntity(
    request,
    getListingWithCount,
    listingId,
    "Listing",
    (listing, _session, body) => handler(listing, body),
  );

/** Custom DELETE handler: performListingDelete handles storage cleanup + logging with counts */
const handleDeleteListing: RouteHandlerFn = (request, { listingId }) =>
  withListing(request, listingId as number, async (listing, body) => {
    const error = verifyIdentifierOrJsonError(
      listing.name,
      body.confirm_identifier,
      "Listing name",
    );
    if (error) return apiErrorResponse(error);
    const orphanError = await deleteOrphanedAddOnError(listing.id);
    if (orphanError) return apiErrorResponse(orphanError);
    await performListingDelete(listing);
    return jsonResponse({ status: "ok" });
  });

/** Toggle listing active/inactive state */
const handleToggleActive = (
  request: Request,
  listingId: number,
  active: boolean,
): Promise<Response> =>
  withListing(request, listingId, async (listing) => {
    const result = await toggleListingActive(listingId, listing, active);
    if ("noChange" in result) {
      return apiErrorResponse(
        `Listing is already ${active ? "active" : "deactivated"}`,
      );
    }
    if ("error" in result) return apiErrorResponse(result.error);
    return jsonResponse({ listing: await toApiListing(result.updated) });
  });

/** Strip slug_index from listing row, producing the admin API shape */
export const toAdminListing = ({
  slug_index: _,
  ...rest
}: ListingWithCount): AdminListing => rest;

/** Batched `group_ids` hydration for a set of listing rows, keyed by listing id
 * — one join-table query for the whole list rather than one per row (the
 * single-row `hydrate` reuses it with a one-element list). */
const hydrateListingGroupIds = async (
  rows: { id: number }[],
): Promise<ReadonlyMap<number, Record<string, unknown>>> => {
  const groupIdsByListing = await listingGroups.getIdsByKeys(
    rows.map((r) => r.id),
  );
  return mapById((row: (typeof rows)[number]) => ({
    group_ids: listingGroups.idsFor(groupIdsByListing, row.id),
  }))(rows);
};

/** One listing as every admin endpoint answers with it: the stored fields plus
 * the ids of the groups it is in. */
const toApiListing = async (
  row: ListingWithCount,
): Promise<Record<string, unknown>> => ({
  ...toAdminListing(row),
  ...(await hydrateListingGroupIds([row])).get(row.id),
});

/** One of the listing's on/off routes: deactivate turns it off, reactivate
 * turns it back on. */
const toggleActiveRoute =
  (active: boolean) =>
  (request: Request, params: RouteParams): Promise<Response> =>
    handleToggleActive(request, params.listingId as number, active);

const listingApiRoutes = defineCrudApi<
  Listing,
  ListingInput,
  ListingWithCount,
  PreparedListingJoins
>({
  afterCommit: syncListingPrices,
  extraRoutes: {
    "DELETE /api/admin/listings/:listingId": handleDeleteListing,
    "POST /api/admin/listings/:listingId/deactivate": toggleActiveRoute(false),
    "POST /api/admin/listings/:listingId/reactivate": toggleActiveRoute(true),
  },
  getAll: getAllListings,
  hydrate: hydrateListingGroupIds,
  linkActivityToRow: true,
  listExtras: (session) => ({ admin_level: session.adminLevel }),
  lookup: getListingWithCount,
  lookupAfterWrite: getListingWithCountPrimary,
  name: "listings",
  nameField: "name",
  sideEffect: {
    persist: persistListingJoins,
    validate: prepareListingJoins,
  },
  singular: "Listing",
  stripKeys: ["slug_index"],
  table: listingsTable,
  toCreateInput: bodyToCreateInput,
  toUpdateInput: bodyToUpdateInput,
  validate: validateListingInput,
});

export const adminApiRoutes = {
  ...holidayApiRoutes,
  ...groupApiRoutes,
  ...listingApiRoutes,
};
