/** JSON body → ListingInput conversion for the admin listing API routes.
 *  Extracted from `api.ts` so that route file stays focused. */

import * as v from "valibot";
import { reduce } from "#fp";
import {
  type CatalogApiBody,
  projectCatalogFields,
} from "#shared/catalog-fields/definition.ts";
import {
  type ListingInput,
  listingCatalogFields,
} from "#shared/catalog-fields/fields.ts";
import { listingGroups } from "#shared/db/groups.ts";
import { getStoredListingWithCount } from "#shared/db/listings/records.ts";
import {
  generateUniqueListingSlug,
  parseUpdatedListingSlug,
} from "#shared/listings-actions.ts";
import {
  bodyNumber,
  parseOptionalArray,
  parseUpdateName,
} from "#shared/rest/crud-parsers.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import type { ListingWithCount } from "#shared/types.ts";

/** JSON body accepted by POST /api/admin/listings. */
export type CreateListingBody = Omit<
  CatalogApiBody<typeof listingCatalogFields>,
  "date"
> & {
  date?: string | null;
  name: string;
  max_attendees: number;
  max_price?: number;
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

/** Parse a day_prices object from a JSON body into DayPrices. Keeps only
 * positive-integer day counts mapped to numeric prices; everything else is
 * dropped so validateCustomisableDays sees a clean structure. */
const parseDayPrices = (raw: unknown): Record<number, number> => {
  if (typeof raw !== "object" || raw === null) return {};
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
  const stored = await getStoredListingWithCount(resolved.id);
  const existing = stored === null ? resolved : stored;
  const parsedName = parseUpdateName(body, existing.name);
  if (!parsedName.ok) return parsedName;

  return withParsedGroupIds(body, async (groupIds) => {
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
      groupIds:
        groupIds === undefined
          ? await listingGroups.getIds(existing.id)
          : groupIds,
      maxAttendees,
      maxPrice: bodyNumber(body, "max_price", existing.max_price),
      name: parsedName.value,
      slug,
      slugIndex,
    } as ListingInput);
  });
};
