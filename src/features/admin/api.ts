/**
 * Admin JSON API routes — accessible via API key or cookie+CSRF.
 *
 * These endpoints expose admin operations as JSON for programmatic access.
 * Authentication is handled by withAuth which accepts either:
 *   - Bearer token (API key) — no CSRF needed
 *   - Session cookie + x-csrf-token header
 */

/* jscpd:ignore-start */
import * as v from "valibot";
import { mapById, reduce } from "#fp";
import { groupApiRoutes } from "#routes/admin/api-groups.ts";
import { holidayApiRoutes } from "#routes/admin/api-holidays.ts";
import { verifyIdentifierOrJsonError } from "#routes/admin/confirmation.ts";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { jsonResponse } from "#routes/response.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import {
  type CatalogApiBody,
  projectCatalogFields,
} from "#shared/catalog-fields/definition.ts";
import {
  type ListingInput,
  listingCatalogFields,
} from "#shared/catalog-fields/fields.ts";
import type { TxScope } from "#shared/db/client.ts";
import {
  anyHiddenPackageGroup,
  anyListingInPackageGroup,
  listingGroups,
  setListingGroupsTx,
} from "#shared/db/groups.ts";
import {
  requireListingChildrenPackageCheck,
  setListingChildrenWithPackageCheckTx,
} from "#shared/db/listing-parents.ts";
import {
  syncListingPrices,
  writeListingDayCounts,
} from "#shared/db/listing-prices.ts";
import {
  getAllListings,
  getListingWithCount,
  getListingWithCountPrimary,
  getStoredListingWithCount,
  listingsTable,
} from "#shared/db/listings/records.ts";
import {
  deleteOrphanedAddOnError,
  generateUniqueListingSlug,
  listingInputToEdge,
  parseUpdatedListingSlug,
  performListingDelete,
  toggleListingActive,
  validateListingInput,
} from "#shared/listings-actions.ts";
import {
  packageChildEdgeConflict,
  packageChildEdgeError,
} from "#shared/package-membership.ts";
import {
  bodyNumber,
  type DeleteBody,
  defineCrudApi,
  parseOptionalArray,
  parseUpdateName,
  withApiEntity,
} from "#shared/rest/crud-api.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import type { AdminListing, Listing, ListingWithCount } from "#shared/types.ts";
import { validateChildEdges } from "./listings-parents.ts";

/* jscpd:ignore-end */

// =============================================================================
// Published API types — the contract for callers
// =============================================================================

/** JSON body accepted by POST /api/admin/listings. */
export type CreateListingBody = Omit<
  CatalogApiBody<typeof listingCatalogFields>,
  "date"
> & {
  date?: string | null;
  name: string;
  max_attendees: number;
  group_ids?: number[];
  /** Day count → price (minor units), e.g. { "1": 1000, "2": 1800 }. */
  day_prices?: Record<number, number>;
  /** Listing ids the buyer must choose one of when this listing is booked (the
   * required-child gate). Only honoured when the parents feature is enabled;
   * self-edges and unknown ids are dropped, and the same nesting/field/add-on
   * validation as the edit form runs before the edges are written. */
  child_listing_ids?: number[];
};

/** JSON body accepted by PUT /api/admin/listings/:listingId (all fields optional) */
export type UpdateListingBody = Partial<CreateListingBody> & { slug?: string };

/** JSON body accepted by DELETE /api/admin/listings/:listingId */
export type DeleteListingBody = DeleteBody;

// =============================================================================
// Schema-driven field extraction
// =============================================================================

const API_BODY_FIELD_RULES = [
  [
    "bookable_days",
    v.array(v.string()),
    "bookable_days must contain only text",
  ],
  [
    "duration_days",
    v.pipe(v.number(), v.safeInteger()),
    "duration_days must be a safe integer",
  ],
  [
    "day_prices",
    v.pipe(
      v.unknown(),
      v.check(
        (raw) =>
          typeof raw !== "object" ||
          raw === null ||
          Object.values(raw).every(
            (price) => typeof price !== "number" || Number.isSafeInteger(price),
          ),
      ),
    ),
    "day_prices numeric values must be safe integers",
  ],
] as const;

/**
 * Parse a day_prices object from a JSON body into DayPrices. Keeps only
 * positive-integer day counts mapped to numeric prices; everything else is
 * dropped so validateCustomisableDays sees a clean structure.
 */
const parseDayPrices = (raw: unknown): Record<number, number> => {
  if (typeof raw !== "object" || raw === null) return {};
  // Keep only positive whole day counts mapped to numeric prices; drop the rest.
  return reduce(
    (kept: Record<number, number>, [key, value]: [string, unknown]) => {
      const day = Number(key);
      if (Number.isInteger(day) && day >= 1 && typeof value === "number") {
        kept[day] = value;
      }
      return kept;
    },
    {},
  )(Object.entries(raw));
};

/** Parse the optional `group_ids` array (group membership). An absent field
 * yields `undefined` (leave membership unchanged); an explicit array (including
 * `[]`) replaces it. Fails closed: any non-positive-integer entry rejects the
 * whole request rather than being silently dropped, so a typo like
 * `["5"]` can't quietly clear a listing's groups. */
const parseGroupIds = (raw: unknown): Result<number[] | undefined> =>
  parseOptionalArray<number>(raw, "group_ids", (entry) =>
    typeof entry === "number" && Number.isInteger(entry) && entry > 0
      ? okResult(entry)
      : errorResult("group_ids must contain only positive integer ids"),
  );

// =============================================================================
// Body → ListingInput converters
// =============================================================================

/** Validate mapped fields and group ids before building the listing input. */
const withParsedGroupIds = (
  body: Record<string, unknown>,
  build: (groupIds: number[] | undefined) => Promise<Result<ListingInput>>,
): Promise<Result<ListingInput>> => {
  const invalid = API_BODY_FIELD_RULES.find(
    ([apiKey, schema]) =>
      body[apiKey] !== undefined && !v.is(schema, body[apiKey]),
  );
  if (invalid) return Promise.resolve(errorResult(invalid[2]));
  const groups = parseGroupIds(body.group_ids);
  return groups.ok ? build(groups.value) : Promise.resolve(groups);
};

/** Convert JSON body to ListingInput for create (auto-generates slug) */
export const bodyToCreateInput = (
  body: Record<string, unknown>,
): Promise<Result<ListingInput>> => {
  if (typeof body.name !== "string" || body.name.trim() === "") {
    return Promise.resolve({ error: "name is required", ok: false });
  }
  if (typeof body.max_attendees !== "number" || body.max_attendees < 1) {
    return Promise.resolve({
      error: "max_attendees is required and must be >= 1",
      ok: false,
    });
  }
  const name = body.name.trim();
  const maxAttendees = body.max_attendees;

  return withParsedGroupIds(body, async (groupIds) => {
    const { slug, slugIndex } = await generateUniqueListingSlug();
    return okResult({
      ...projectCatalogFields(listingCatalogFields, "api", body),
      dayPrices: parseDayPrices(body.day_prices),
      groupIds,
      maxAttendees,
      maxPrice: bodyNumber(body, "max_price", 0),
      name,
      slug,
      slugIndex,
    } as ListingInput);
  });
};

/** Convert JSON body to ListingInput for update (merges with existing) */
export const bodyToUpdateInput = async (
  body: Record<string, unknown>,
  resolved: ListingWithCount,
): Promise<Result<ListingInput>> => {
  // Merge the patch onto the listing's *stored* values, not the resolved view,
  // so an API update that doesn't touch a defaulted field can't bake the current
  // default into the row (mirrors the HTML edit path). The lookup row is
  // resolved; fall back to it only if the stored re-read races a delete.
  const existing = (await getStoredListingWithCount(resolved.id)) ?? resolved;
  const parsedName = parseUpdateName(body, existing.name);
  if (!parsedName.ok) return parsedName;

  return withParsedGroupIds(body, async (groupIds) => {
    const existingGroupIds = await listingGroups.getIds(existing.id);
    const maxAttendees = bodyNumber(
      body,
      "max_attendees",
      existing.max_attendees,
    );
    if (maxAttendees < 1) {
      return errorResult("max_attendees must be >= 1");
    }

    const { slug, slugIndex } = await parseUpdatedListingSlug(
      body,
      existing.slug,
    );

    return okResult({
      ...projectCatalogFields(listingCatalogFields, "storedApi", existing),
      ...projectCatalogFields(listingCatalogFields, "api", body),
      dayPrices:
        body.day_prices !== undefined
          ? parseDayPrices(body.day_prices)
          : existing.day_prices,
      // Omitted group_ids → fall back to the listing's CURRENT membership, so a
      // partial update validates listing-type/customisable-days against the
      // groups it stays in (and child-edge checks see the real groups).
      // afterWrite then rewrites the same set — a no-op when unchanged.
      groupIds: groupIds ?? existingGroupIds,
      maxAttendees,
      maxPrice: bodyNumber(body, "max_price", existing.max_price),
      name: parsedName.value,
      slug,
      slugIndex,
    } as ListingInput);
  });
};

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
    // Same orphaned-add-on guard the HTML delete uses: reject
    // a delete that would leave a child-scoped add-on reachable only through a
    // suppressed child, with the same 400 + error as the deactivate API.
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
    // A deactivation that would orphan a child-scoped add-on is rejected with
    // the same 400 + error the HTML deactivate route gives.
    if ("error" in result) return apiErrorResponse(result.error);
    return jsonResponse({ listing: await toApiListing(result.updated) });
  });

/** Strip slug_index from listing row, producing the admin API shape */
export const toAdminListing = ({
  slug_index: _,
  ...rest
}: ListingWithCount): AdminListing => rest;

/**
 * Interpret the optional `child_listing_ids` field on a write body, telling
 * three cases apart so a client typo can never silently wipe existing edges:
 * - `{ skip: true }` — the parents feature is off or the field is omitted, so
 *   the API leaves the listing's existing edges untouched;
 * - `{ error }` — the field is present but malformed: not an array (a string,
 *   object, …), or an array containing any entry that is not a positive integer
 *   listing id (e.g. a JSON client sending `["7"]`). Both are reported as a 400
 *   with the edges left intact — failing closed, so a typo can never silently
 *   wipe a gated parent's edges down to an empty replacement;
 * - `{ childIds }` — a real array of positive integer ids, ready for
 *   {@link writeChildEdges} (self-edges and unknown ids are still dropped
 *   downstream by {@link validateChildEdges}).
 */
type SubmittedChildIds =
  | { skip: true }
  | { error: string }
  | { childIds: number[] };

const submittedChildIds = (
  body: Record<string, unknown>,
): SubmittedChildIds => {
  if (body.child_listing_ids === undefined) {
    return { skip: true };
  }
  const raw = body.child_listing_ids;
  if (!Array.isArray(raw)) {
    return { error: "child_listing_ids must be an array of listing ids" };
  }
  // Fail closed on any non-positive-integer entry (a stringified id, float, …)
  // rather than filtering it out: silently dropping it could shrink the array to
  // empty and turn a gated parent into a standalone listing.
  if (
    !raw.every((id) => typeof id === "number" && Number.isInteger(id) && id > 0)
  ) {
    return {
      error: "child_listing_ids must contain only positive integer listing ids",
    };
  }
  return { childIds: raw };
};

/** A placeholder id for a not-yet-created parent: listing ids are positive
 * autoincrement, so no real listing (and so no real edge) can reference this,
 * making the pre-create child-edge validation behave exactly as for a parent
 * that doesn't exist yet. */
const UNCREATED_PARENT_ID = -1;

/** The prepared child-edge write: `null` = leave existing edges untouched
 * (field omitted / feature off); an array = replace the parent's edges with
 * these cleaned ids. */
type PreparedChildEdges = number[] | null;

/** Both of a listing write's join-table writes, prepared before the row write so
 * they commit in its transaction: the child edges and the group membership
 * (`groupIds` undefined = field omitted, leave membership untouched). */
type PreparedListingJoins = {
  childEdges: PreparedChildEdges;
  groupIds: number[] | undefined;
};

/**
 * Validate a write's `child_listing_ids` against the would-be parent BEFORE the
 * row is written (for atomicity): a rejected edge returns `{ error }` (the
 * whole write is skipped, leaving no partial row create/rename); otherwise it
 * yields the cleaned ids to write once the row exists. The would-be
 * {@link EdgeListing} comes from the parsed input (the *fully merged*
 * ListingInput — `bodyToUpdateInput` folds in the existing defaults, so its
 * fields are the authoritative post-save values) via the shared
 * {@link listingInputToEdge}; on create there is no row yet, so a placeholder id
 * stands in. `null` value when the field is omitted / the parents feature is off
 * (existing edges left intact); a present-but-malformed field is rejected.
 */
const prepareListingJoins = async (
  input: ListingInput,
  body: Record<string, unknown>,
  existing: ListingWithCount | null,
): Promise<{ error: string } | { value: PreparedListingJoins }> => {
  const groupIds = input.groupIds;
  const submitted = submittedChildIds(body);
  if ("skip" in submitted) return { value: { childEdges: null, groupIds } };
  if ("error" in submitted) return submitted;
  // A listing gaining children becomes a parent; a HIDDEN package's member
  // can't be a parent (the child selector would name the collapsed members),
  // and a package member can't become a child. The group/listing validators
  // only see edges that already exist, so reject the brand-new edges here,
  // before the row + edges commit together.
  const packageConflict = await packageChildEdgeConflict(
    submitted.childIds,
    () => anyHiddenPackageGroup(input.groupIds ?? []),
    () => anyListingInPackageGroup(submitted.childIds),
  );
  if (packageConflict) {
    return { error: packageChildEdgeError(packageConflict) };
  }
  // Resolve add-on reachability against the POST-SAVE listing set: apply the
  // submitted `group_id` to the parent in an in-memory listing set so a parent
  // created/moved into the same group as a child's group-scoped add-on is judged
  // by its would-be group, not the live table that ignores `group_id`.
  // On create the row doesn't exist yet, so the would-be group still applies to
  // the placeholder id (no live group membership to mislead the check).
  const result = await validateChildEdges(
    listingInputToEdge(input, existing?.id ?? UNCREATED_PARENT_ID),
    submitted.childIds,
    { wouldBeGroupIds: input.groupIds ?? [] },
  );
  return result.ok
    ? { value: { childEdges: result.childIds, groupIds } }
    : { error: result.error };
};

/** Write the prepared join-table rows on the open write transaction,
 * atomically with the listing row: child edges (a no-op when `null`, i.e. field
 * omitted) and group membership (a no-op when `undefined`). */
const persistListingJoins = async (
  tx: TxScope,
  listingId: number,
  value: PreparedListingJoins,
): Promise<void> => {
  if (value.groupIds !== undefined) {
    await setListingGroupsTx(
      tx,
      listingId,
      value.groupIds,
      value.childEdges === null ? undefined : value.childEdges.length > 0,
    );
  }
  if (value.childEdges !== null) {
    requireListingChildrenPackageCheck(
      await setListingChildrenWithPackageCheckTx(
        tx,
        listingId,
        value.childEdges,
      ),
    );
  }
};

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

const listingApiRoutes = defineCrudApi<
  Listing,
  ListingInput,
  ListingWithCount,
  PreparedListingJoins
>({
  // Keep listing_prices in step on the transactional API write path, which uses
  // insertStatement/updateStatement and so bypasses the listingsTable wrapper
  // that syncs the form/direct write paths. The `base` mirror reconciles from the
  // surviving unit_price column post-commit (afterCommit, reads the just-written
  // row on the primary); the `day_count` rows have no column, so they are written
  // from the submitted day prices in the write transaction (afterWrite).
  afterCommit: syncListingPrices,
  afterWrite: (tx, id, input) => writeListingDayCounts(tx, id, input.dayPrices),
  extraRoutes: {
    "DELETE /api/admin/listings/:listingId": handleDeleteListing,
    "POST /api/admin/listings/:listingId/deactivate": (
      request,
      { listingId },
    ) => handleToggleActive(request, listingId as number, false),
    "POST /api/admin/listings/:listingId/reactivate": (
      request,
      { listingId },
    ) => handleToggleActive(request, listingId as number, true),
  },
  getAll: getAllListings,
  // Group membership lives in the join table, not a listing column, so surface
  // it on every response (list/get/create/update) — clients POST/PUT group_ids
  // and must be able to read them back to round-trip listing group state.
  // get/create/update hydrate the single written row; the list endpoint uses
  // the batched hydrateList below to avoid an N+1 over the returned listings.
  hydrate: hydrateListingGroupIds,
  linkActivityToRow: true,
  listExtras: (session) => ({ admin_level: session.adminLevel }),
  lookup: getListingWithCount,
  // Reading the row back after its own write must hit the primary — a replica
  // read (as the cache-backed `lookup` does on a miss) can lag the commit and
  // return null, crashing the write response on `.id`.
  lookupAfterWrite: getListingWithCountPrimary,
  name: "listings",
  nameField: "name",
  // The required-child gate and group membership are atomic side effects (Fix
  // 4): validate the would-be edges/membership BEFORE the row write (a rejected
  // edge skips the whole write, leaving no orphan create / no persisted
  // rename), then write them in the SAME transaction once the row exists.
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
