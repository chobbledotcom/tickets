/**
 * Admin JSON API routes — accessible via API key or cookie+CSRF.
 *
 * These endpoints expose admin operations as JSON for programmatic access.
 * Authentication is handled by withAuth which accepts either:
 *   - Bearer token (API key) — no CSRF needed
 *   - Session cookie + x-csrf-token header
 */

import { decryptAttendees } from "#db/attendees/pii.ts";
import { listingAttributeOptions } from "#db/attributes.ts";
import { listingGroups } from "#db/groups/table.ts";
import { syncListingPrices } from "#db/listing-price-sync.ts";
import { getListingWithAttendeesRaw } from "#db/listings/attendees.ts";
import {
  getAllListings,
  getListingWithCount,
  getListingWithCountPrimary,
  listingsTable,
} from "#db/listings/records.ts";
/* jscpd:ignore-start */
import { mapById, requiredMapValue } from "#fp";
import { attributeApiRoutes } from "#routes/admin/api-attributes.ts";
import { groupApiRoutes } from "#routes/admin/api-groups.ts";
import { holidayApiRoutes } from "#routes/admin/api-holidays.ts";
import { verifyIdentifierOrJsonError } from "#routes/admin/confirmation.ts";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { ADMIN_API, CONTENT_API } from "#routes/auth.ts";
import { jsonResponse } from "#routes/response.ts";
import type { RouteHandlerFn, RouteParams } from "#routes/router.ts";
import { listingSaveOrphanedAddOnTx } from "#shared/add-on-reachability.ts";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import {
  performListingDelete,
  toggleListingActive,
  validateListingInput,
} from "#shared/listings-actions.ts";
import { defineCrudApi } from "#shared/rest/crud-api.ts";
import { apiEntityGate, withApiEntity } from "#shared/rest/crud-parsers.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { AdminListing, Attendee, Listing, ListingWithCount } from "#types";
import { bodyToCreateInput, bodyToUpdateInput } from "./api-listing-body.ts";
import {
  type PreparedListingJoins,
  persistListingJoins,
  prepareChildEdges,
  prepareListingJoins,
} from "./api-listing-joins.ts";

/* jscpd:ignore-end */

// DELETE /api/admin/listings/:listingId takes the shared DeleteBody the
// crud-parsers module exports.

// =============================================================================
// Custom routes (delete with cleanup, activate/deactivate)
// =============================================================================

// The listing delete, deactivate, and reactivate routes are staff-only, the
// same audience the dashboard's lifecycle controls declare
// (areas-a-l.ts "listings": listingDelete, deactivate, reactivate).
const listingGate = apiEntityGate(getListingWithCount, "Listing", ADMIN_API);

/** Custom DELETE handler: performListingDelete runs the orphaned-add-on guard
 * and the DB deletes in one transaction, then cleans up storage and logs */
const handleDeleteListing: RouteHandlerFn = (request, { listingId }) =>
  listingGate(request, listingId as number, async (listing, body) => {
    const error = verifyIdentifierOrJsonError(
      listing.name,
      body.confirm_identifier,
      "Listing name",
    );
    if (error) return apiErrorResponse(error);
    const orphanError = await performListingDelete(listing);
    if (orphanError) return apiErrorResponse(orphanError);
    return jsonResponse({ status: "ok" });
  });

/** Toggle listing active/inactive state */
const handleToggleActive = (
  request: Request,
  listingId: number,
  active: boolean,
): Promise<Response> =>
  listingGate(request, listingId, async (listing) => {
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

/** Batched join-table hydration for a set of listing rows, keyed by listing
 * id. One query per link table covers the whole list rather than one per row.
 * The single-row `hydrate` reuses it with a one-element list. */
const hydrateListingJoins = async (
  rows: { id: number }[],
): Promise<ReadonlyMap<number, Record<string, unknown>>> => {
  const ids = rows.map((row) => row.id);
  const [groupIdsByListing, optionIdsByListing] = await Promise.all([
    listingGroups.getIdsByKeys(ids),
    listingAttributeOptions.getIdsByKeys(ids),
  ]);
  return mapById((row: (typeof rows)[number]) => ({
    attribute_option_ids: requiredMapValue(
      optionIdsByListing,
      row.id,
      "Missing listing attribute selection",
    ),
    group_ids: listingGroups.idsFor(groupIdsByListing, row.id),
  }))(rows);
};

/** One listing as every admin endpoint answers with it: the stored fields,
 * plus the ids of its groups, plus its selected attribute options. */
const toApiListing = async (
  row: ListingWithCount,
): Promise<Record<string, unknown>> => ({
  ...toAdminListing(row),
  ...(await hydrateListingJoins([row])).get(row.id),
});

/** One of the listing's on/off routes: deactivate turns it off, reactivate
 * turns it back on. */
const toggleActiveRoute =
  (active: boolean) =>
  (request: Request, params: RouteParams): Promise<Response> =>
    handleToggleActive(request, params.listingId as number, active);

/** One attendee booking row as the admin API answers with it: the decrypted
 * roster row minus the sealed PII blob and its blind index. Storage details go
 * the same way slug_index goes from listing responses. */
export type AdminApiAttendee = Omit<
  Attendee,
  "pii_blob" | "ticket_token_index"
>;

const toApiAttendee = ({
  pii_blob: _,
  ticket_token_index: __,
  ...attendee
}: Attendee): AdminApiAttendee => attendee;

/** The listing's roster as JSON. One row per booking line, newest first.
 * Every line shows, including a quantity-0 placeholder, and a booking on
 * another listing never appears. Staff-only: the dashboard's roster tab is a
 * staff-only surface (listing-page.ts), and the answers carry decrypted
 * attendee PII. */
const handleListingAttendees: RouteHandlerFn = (request, { listingId }) =>
  withApiEntity(
    request,
    getListingWithAttendeesRaw,
    listingId as number,
    "Listing",
    async (result) =>
      jsonResponse({
        attendees: (
          await decryptAttendees(
            result.attendeesRaw,
            await requireRequestPrivateKey(),
          )
        ).map(toApiAttendee),
      }),
    ADMIN_API,
  );

/** The JSON write's join validation: the base joins come from the input. The
 *  child edges come from the body, validated against the parent before the row
 *  is written. */
const prepareApiListingJoins = async (
  input: ListingInput,
  body: Record<string, unknown>,
  existing: ListingWithCount | null,
): Promise<{ error: string } | { value: PreparedListingJoins }> => {
  const childEdges = await prepareChildEdges(body, input, existing);
  if ("error" in childEdges) return childEdges;
  return {
    value: { ...prepareListingJoins(input), childEdges: childEdges.childIds },
  };
};

const listingApiRoutes = defineCrudApi<
  typeof ADMIN_API_RESOURCES.listings,
  Listing,
  ListingInput,
  ListingWithCount,
  PreparedListingJoins
>(ADMIN_API_RESOURCES.listings, {
  afterCommit: syncListingPrices,
  // The add-on reachability half of the save refuses inside the row write's
  // transaction, so two concurrent page-removing saves cannot both commit.
  checkTx: listingSaveOrphanedAddOnTx,
  customHandlers: {
    attendees: handleListingAttendees,
    deactivate: toggleActiveRoute(false),
    delete: handleDeleteListing,
    reactivate: toggleActiveRoute(true),
  },
  // Role parity with the listing pages: create/edit/duplicate admit content
  // admins (owner, manager, editor — areas-a-l.ts "listings"). The delete,
  // deactivate, and reactivate routes are staff-only. An editor therefore
  // writes through the API exactly as far as the dashboard allows.
  deletePolicy: ADMIN_API,
  getAll: getAllListings,
  hydrate: hydrateListingJoins,
  linkActivityToRow: true,
  listExtras: (session) => ({ admin_level: session.adminLevel }),
  lookup: getListingWithCount,
  lookupAfterWrite: getListingWithCountPrimary,
  nameField: "name",
  policy: CONTENT_API,
  /** The dashboard's editor table is money-free (listing-table.tsx), so the
   *  editor's API answers hide the staff-only money totals too. The editor
   *  form also hides webhook_url and use_defaults. The write parser freezes
   *  both: the stored webhook receives attendee PII, and its URL can carry
   *  credentials or query tokens. */
  projectResponse: (row, session) => {
    if (session.adminLevel !== "editor") return row;
    const {
      cost: _cost,
      income: _income,
      profit: _profit,
      use_defaults: _useDefaults,
      webhook_url: _webhookUrl,
      ...rest
    } = row;
    return rest;
  },
  sideEffect: {
    persist: persistListingJoins,
    validate: prepareApiListingJoins,
  },
  stripKeys: ["slug_index"],
  table: listingsTable,
  toCreateInput: bodyToCreateInput,
  toUpdateInput: bodyToUpdateInput,
  validate: validateListingInput,
});

export const adminApiRoutes = {
  ...attributeApiRoutes,
  ...holidayApiRoutes,
  ...groupApiRoutes,
  ...listingApiRoutes,
};
