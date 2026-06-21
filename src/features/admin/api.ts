/**
 * Admin JSON API routes — accessible via API key or cookie+CSRF.
 *
 * These endpoints expose admin operations as JSON for programmatic access.
 * Authentication is handled by withAuth which accepts either:
 *   - Bearer token (API key) — no CSRF needed
 *   - Session cookie + x-csrf-token header
 */

import { groupApiRoutes } from "#routes/admin/api-groups.ts";
import { holidayApiRoutes } from "#routes/admin/api-holidays.ts";
import { verifyIdentifierOrJsonError } from "#routes/admin/confirmation.ts";
import { jsonResponse } from "#routes/response.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import { isListingParentsEnabled } from "#shared/config.ts";
import { setChildIds } from "#shared/db/listing-parents.ts";
import {
  computeSlugIndex,
  getAllListings,
  getListingWithCount,
  type ListingInput,
  listingsTable,
} from "#shared/db/listings.ts";
import {
  generateUniqueListingSlug,
  performListingDelete,
  toggleListingActive,
  validateListingInput,
} from "#shared/listings-actions.ts";
import {
  apiErrorResponse,
  type DeleteBody,
  defineCrudApi,
  type ParseResult,
  parseUpdateName,
  parseUpdateSlug,
  withApiEntity,
} from "#shared/rest/crud-api.ts";
import { normalizeSlug } from "#shared/slug.ts";
import type {
  AdminListing,
  Listing,
  ListingType,
  ListingWithCount,
} from "#shared/types.ts";
import { validateChildEdges } from "./listings-parents.ts";

// =============================================================================
// Published API types — the contract for callers
// =============================================================================

/** JSON body accepted by POST /api/admin/listings */
export type CreateListingBody = {
  name: string;
  max_attendees: number;
  max_price?: number;
  description?: string;
  date?: string | null;
  location?: string;
  group_id?: number;
  unit_price?: number;
  max_quantity?: number;
  thank_you_url?: string;
  webhook_url?: string;
  active?: boolean;
  fields?: string;
  closes_at?: string | null;
  listing_type?: ListingType;
  bookable_days?: string[];
  minimum_days_before?: number;
  maximum_days_after?: number;
  duration_days?: number;
  non_transferable?: boolean;
  can_pay_more?: boolean;
  customisable_days?: boolean;
  /** Day count → price (minor units), e.g. { "1": 1000, "2": 1800 }. */
  day_prices?: Record<number, number>;
  hidden?: boolean;
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

/** Field type tag for runtime checking */
type FieldType = "string" | "number" | "boolean" | "string[]";

/** The possible value types for listing fields */
type FieldValue = string | number | boolean | string[];

/** Partial ListingInput fields keyed by camelCase name */
type FieldRecord = Record<string, FieldValue>;

/**
 * Field mapping: [apiKey, listingInputKey, type]
 *
 * Single source of truth for the snake_case → camelCase mapping.
 * Drives both bodyToCreateInput (extract from JSON body) and
 * bodyToUpdateInput (defaults from existing listing).
 */
type FieldMapping = readonly [string, string, FieldType];

const optionalFields: FieldMapping[] = [
  ["description", "description", "string"],
  ["date", "date", "string"],
  ["location", "location", "string"],
  ["group_id", "groupId", "number"],
  ["unit_price", "unitPrice", "number"],
  ["max_quantity", "maxQuantity", "number"],
  ["thank_you_url", "thankYouUrl", "string"],
  ["webhook_url", "webhookUrl", "string"],
  ["active", "active", "boolean"],
  ["fields", "fields", "string"],
  ["closes_at", "closesAt", "string"],
  ["listing_type", "listingType", "string"],
  ["bookable_days", "bookableDays", "string[]"],
  ["minimum_days_before", "minimumDaysBefore", "number"],
  ["maximum_days_after", "maximumDaysAfter", "number"],
  ["duration_days", "durationDays", "number"],
  ["non_transferable", "nonTransferable", "boolean"],
  ["can_pay_more", "canPayMore", "boolean"],
  ["customisable_days", "customisableDays", "boolean"],
  ["hidden", "hidden", "boolean"],
];

/**
 * Parse a day_prices object from a JSON body into DayPrices. Keeps only
 * positive-integer day counts mapped to numeric prices; everything else is
 * dropped so validateCustomisableDays sees a clean structure.
 */
const parseDayPrices = (raw: unknown): Record<number, number> => {
  if (typeof raw !== "object" || raw === null) return {};
  const result: Record<number, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    const day = Number(key);
    if (Number.isInteger(day) && day >= 1 && typeof value === "number") {
      result[day] = value;
    }
  }
  return result;
};

/** Check whether a value matches the expected field type */
const matchesType = (val: unknown, type: FieldType): val is FieldValue =>
  type === "string"
    ? typeof val === "string"
    : type === "number"
      ? typeof val === "number"
      : type === "boolean"
        ? typeof val === "boolean"
        : Array.isArray(val);

/**
 * Extract typed fields from a JSON body using field mappings.
 * Skips fields that are missing or have the wrong type.
 * Null values are included as empty strings (explicit clear).
 */
const pickTypedFields = (
  body: Record<string, unknown>,
  fields: FieldMapping[],
): FieldRecord => {
  const result: FieldRecord = {};
  for (const [apiKey, outKey, type] of fields) {
    const val = body[apiKey];
    if (val === undefined) continue;
    if (val === null) {
      result[outKey] = "";
      continue;
    }
    if (matchesType(val, type)) result[outKey] = val;
  }
  return result;
};

/**
 * Build ListingInput defaults from an existing listing (for updates).
 * Maps snake_case Listing fields to camelCase ListingInput keys.
 */
const existingToDefaults = (existing: ListingWithCount): FieldRecord => {
  const result: FieldRecord = {};
  for (const [apiKey, outKey] of optionalFields) {
    // optionalFields only names scalar/array columns, so the value is always a
    // FieldValue at runtime; the cast narrows away object columns (e.g.
    // day_prices) that the indexed-access type otherwise admits.
    const val = existing[apiKey as keyof ListingWithCount] as FieldValue | null;
    result[outKey] = val === null ? "" : val;
  }
  return result;
};

// =============================================================================
// Body → ListingInput converters
// =============================================================================

/** Convert JSON body to ListingInput for create (auto-generates slug) */
export const bodyToCreateInput = async (
  body: Record<string, unknown>,
): Promise<ParseResult<ListingInput>> => {
  if (typeof body.name !== "string" || body.name.trim() === "") {
    return { error: "name is required", ok: false };
  }
  if (typeof body.max_attendees !== "number" || body.max_attendees < 1) {
    return { error: "max_attendees is required and must be >= 1", ok: false };
  }

  const { slug, slugIndex } = await generateUniqueListingSlug();

  return {
    input: {
      ...pickTypedFields(body, optionalFields),
      dayPrices: parseDayPrices(body.day_prices),
      maxAttendees: body.max_attendees,
      maxPrice: typeof body.max_price === "number" ? body.max_price : 0,
      name: body.name.trim(),
      slug,
      slugIndex,
    } as ListingInput,
    ok: true,
  };
};

/** Convert JSON body to ListingInput for update (merges with existing) */
export const bodyToUpdateInput = async (
  body: Record<string, unknown>,
  existing: ListingWithCount,
): Promise<ParseResult<ListingInput>> => {
  const parsedName = parseUpdateName(body, existing.name);
  if (!parsedName.ok) return parsedName;

  const maxAttendees =
    typeof body.max_attendees === "number"
      ? body.max_attendees
      : existing.max_attendees;
  if (maxAttendees < 1) {
    return { error: "max_attendees must be >= 1", ok: false };
  }

  const { slug, slugIndex } = await parseUpdateSlug(
    body,
    existing.slug,
    normalizeSlug,
    computeSlugIndex,
  );

  return {
    input: {
      ...existingToDefaults(existing),
      ...pickTypedFields(body, optionalFields),
      dayPrices:
        body.day_prices !== undefined
          ? parseDayPrices(body.day_prices)
          : existing.day_prices,
      maxAttendees,
      maxPrice:
        typeof body.max_price === "number"
          ? body.max_price
          : existing.max_price,
      name: parsedName.name,
      slug,
      slugIndex,
    } as ListingInput,
    ok: true,
  };
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
    const updated = await toggleListingActive(listingId, listing, active);
    if (!updated) {
      return apiErrorResponse(
        `Listing is already ${active ? "active" : "deactivated"}`,
      );
    }
    return jsonResponse({ listing: toAdminListing(updated) });
  });

/** Strip slug_index from listing row, producing the admin API shape */
export const toAdminListing = ({
  slug_index: _,
  ...rest
}: ListingWithCount): AdminListing => rest;

/** The submitted `child_listing_ids` as a numeric array (non-numbers dropped),
 * or null when the parents feature is off or the body omits the field — in
 * which case the API leaves a listing's existing edges untouched. */
const submittedChildIds = (body: Record<string, unknown>): number[] | null => {
  if (!isListingParentsEnabled() || body.child_listing_ids === undefined) {
    return null;
  }
  const raw = body.child_listing_ids;
  return Array.isArray(raw)
    ? raw.filter((id): id is number => typeof id === "number")
    : [];
};

/**
 * Apply the parsed `child_listing_ids` to a freshly written listing, using the
 * SAME diff + validation as the edit form ({@link validateChildEdges}) so the
 * API can recreate (or update) the required-child gate. Returns an error message
 * (reported as a 400, edges unwritten) on a validation failure.
 */
const writeChildEdges = async (
  parent: ListingWithCount,
  submitted: number[],
): Promise<string | null> => {
  const result = await validateChildEdges(parent, submitted);
  if (!result.ok) return result.error;
  await setChildIds(parent.id, result.childIds);
  return null;
};

const listingApiRoutes = defineCrudApi<Listing, ListingInput, ListingWithCount>(
  {
    // No-op — the field is ignored — when the parents feature is off or the body
    // omits it; otherwise validate + persist the required-child gate.
    afterWrite: (listing, body) => {
      const submitted = submittedChildIds(body);
      return submitted === null
        ? Promise.resolve(null)
        : writeChildEdges(listing, submitted);
    },
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
    linkActivityToRow: true,
    listExtras: (session) => ({ admin_level: session.adminLevel }),
    lookup: getListingWithCount,
    name: "listings",
    nameField: "name",
    singular: "Listing",
    stripKeys: ["slug_index"],
    table: listingsTable,
    toCreateInput: bodyToCreateInput,
    toUpdateInput: bodyToUpdateInput,
    validate: validateListingInput,
  },
);

export const adminApiRoutes = {
  ...holidayApiRoutes,
  ...groupApiRoutes,
  ...listingApiRoutes,
};
