/** JSON body → ListingInput conversion for the admin listing API routes.
 *  Extracted from `api.ts` so that route file stays focused. */

import * as v from "valibot";
import { listingGroups } from "#db/groups/table.ts";
import { getStoredListingWithCount } from "#db/listings/records.ts";
import { reduce } from "#fp";
import {
  type CatalogApiBody,
  projectCatalogFields,
} from "#shared/catalog-fields/definition.ts";
import {
  type ListingInput,
  listingCatalogFields,
} from "#shared/catalog-fields/fields.ts";
import {
  generateUniqueListingSlug,
  parseUpdatedListingSlug,
} from "#shared/listings-actions.ts";
// jscpd:ignore-start
import {
  bodyNumber,
  parseOptionalArray,
  requireEntityName,
} from "#shared/rest/crud-parsers.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
// jscpd:ignore-end
import { isUtcInstantOfRealDay } from "#shared/validation/date-string.ts";
import type { AdminSession, ListingWithCount } from "#types";

/** JSON body accepted by POST /api/admin/listings. */
export type CreateListingBody = Omit<
  CatalogApiBody<typeof listingCatalogFields>,
  "date"
> & {
  /** Selected attribute option ids (the Attributes feature). */
  attribute_option_ids?: number[];
  date?: string | null;
  name: string;
  max_attendees: number;
  max_price?: number;
  group_ids?: number[];
  /** Day count to price (minor units), for example { "1": 1000, "2": 1800 }. */
  day_prices?: Record<number, number>;
  /** Listing ids the buyer must choose one of when this listing is booked (the
   * required-child gate). Only honoured when the parents feature is enabled.
   * Self-edges and unknown ids are dropped, and the same nesting/field/add-on
   * validation as the edit form runs before the edges are written. */
  child_listing_ids?: number[];
};

/** JSON body accepted by PUT /api/admin/listings/:listingId (all fields optional) */
export type UpdateListingBody = Partial<CreateListingBody> & { slug?: string };

/** The listing fields an editor session cannot set, shared by both surfaces.
 *  The dashboard's form freezes them to their stored values
 *  (parseListingForm). The JSON body parser strips them, so the stored values
 *  stand on update and the column defaults on create.
 *
 *  The registration webhook posts full attendee PII to webhook_url.
 *  use_defaults changes the same effective webhook. active drives the bookable
 *  state. Only the staff lifecycle routes change it. */
export const EDITOR_LOCKED_LISTING_FIELDS = [
  "active",
  "use_defaults",
  "webhook_url",
] as const;

const EDITOR_LOCKED_SET: ReadonlySet<string> = new Set(
  EDITOR_LOCKED_LISTING_FIELDS,
);

/** Fields the JSON body cannot set for an editor. Staff sessions keep setting
 *  all three through the API. The add-on orphan guard's rejection tests pin
 *  that path. */
const withoutEditorLockedFields = (
  body: Record<string, unknown>,
  session: AdminSession | undefined,
): Record<string, unknown> => {
  if (session?.adminLevel !== "editor") return body;
  return Object.fromEntries(
    Object.entries(body).filter(([key]) => !EDITOR_LOCKED_SET.has(key)),
  );
};

const INSTANT_OR_NULL = v.union([
  v.null(),
  v.pipe(v.string(), v.check(isUtcInstantOfRealDay)),
]);

/** The listing date accepts "" beside the usual instants. An undated
 *  listing stores "" and the GET reads it back as "", so the update
 *  boundary accepts the sentinel and keeps the round trip. */
const DATE_OR_EMPTY = v.union([INSTANT_OR_NULL, v.literal("")]);

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
    "closes_at",
    INSTANT_OR_NULL,
    "closes_at must be a UTC instant of a real calendar day",
  ],
  ["date", DATE_OR_EMPTY, "date must be a UTC instant of a real calendar day"],
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
 * positive-integer day counts mapped to numeric prices. Everything else is
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

/** Parse an optional array of positive integer ids (group membership or
 * selected attribute options). An absent field yields `undefined` and leaves
 * the stored links unchanged. An explicit array (including `[]`) replaces
 * them. Fails closed: any non-positive-integer entry rejects the whole
 * request rather than a silent drop, so a typo like `["5"]` cannot quietly
 * clear a listing's links. */
const parseOptionalIdArray = (
  raw: unknown,
  label: string,
): Result<number[] | undefined> =>
  parseOptionalArray<number>(raw, label, (entry) =>
    typeof entry === "number" && Number.isInteger(entry) && entry > 0
      ? okResult(entry)
      : errorResult(`${label} must contain only positive integer ids`),
  );

/** The join-table id arrays a listing write body can carry, keyed by the JSON
 * field names the clients send. */
export type ListingJoinIds = {
  attributeOptionIds: number[] | undefined;
  groupIds: number[] | undefined;
};

/** Validate mapped fields and the join-table id arrays before building the
 * listing input. Attribute assignment is owner-only in the dashboard: the
 * listing choice post runs under OWNER_FORM and the attributes resource under
 * OWNER_API. The JSON field is therefore owner-only too. A write that carries
 * it without an owner session is refused, and one without the field keeps the
 * writer's normal listing access. */
const withParsedJoinIds = (
  session: AdminSession | undefined,
  body: Record<string, unknown>,
  build: (joinIds: ListingJoinIds) => Promise<Result<ListingInput>>,
): Promise<Result<ListingInput>> => {
  if (
    body.attribute_option_ids !== undefined &&
    session?.adminLevel !== "owner"
  ) {
    return Promise.resolve(errorResult("attribute_option_ids is owner-only"));
  }
  const invalid = API_BODY_FIELD_RULES.find(
    ([apiKey, schema]) =>
      body[apiKey] !== undefined && !v.is(schema, body[apiKey]),
  );
  if (invalid) return Promise.resolve(errorResult(invalid[2]));
  const groupIds = parseOptionalIdArray(body.group_ids, "group_ids");
  if (!groupIds.ok) return Promise.resolve(groupIds);
  const attributeOptionIds = parseOptionalIdArray(
    body.attribute_option_ids,
    "attribute_option_ids",
  );
  return attributeOptionIds.ok
    ? build({
        attributeOptionIds: attributeOptionIds.value,
        groupIds: groupIds.value,
      })
    : Promise.resolve(attributeOptionIds);
};

/** Convert JSON body to ListingInput for create (auto-generates slug) */
export const bodyToCreateInput = (
  body: Record<string, unknown>,
  _existing: null = null,
  session?: AdminSession,
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

  return withParsedJoinIds(session, body, async (joinIds) => {
    const { slug, slugIndex } = await generateUniqueListingSlug();
    return okResult({
      ...projectCatalogFields(
        listingCatalogFields,
        "api",
        withoutEditorLockedFields(body, session),
      ),
      attributeOptionIds: joinIds.attributeOptionIds,
      dayPrices: parseDayPrices(body.day_prices),
      groupIds: joinIds.groupIds,
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
  session?: AdminSession,
): Promise<Result<ListingInput>> => {
  const stored = await getStoredListingWithCount(resolved.id);
  const existing = stored === null ? resolved : stored;
  const parsedName = requireEntityName(body, existing.name);
  if (!parsedName.ok) return parsedName;

  return withParsedJoinIds(session, body, async (joinIds) => {
    const maxAttendees = bodyNumber(
      body,
      "max_attendees",
      existing.max_attendees,
    );
    if (!Number.isInteger(maxAttendees) || maxAttendees < 1) {
      return errorResult("max_attendees must be a whole number of at least 1");
    }

    const { slug, slugIndex } = await parseUpdatedListingSlug(
      body,
      existing.slug,
    );

    return okResult({
      ...projectCatalogFields(listingCatalogFields, "storedApi", existing),
      ...projectCatalogFields(
        listingCatalogFields,
        "api",
        withoutEditorLockedFields(body, session),
      ),
      // The JSON API cannot set these four fields, so fold the stored ones in
      // as the update's final facts. An update that adds groups or children
      // must read them the way the validators do, not as absent-and-false.
      assignBuiltSite: existing.assign_built_site,
      // An omitted attribute_option_ids leaves the stored links untouched.
      // persistListingJoins skips the link write for an undefined selection.
      // So an unrelated update never restores a stale one.
      attributeOptionIds: joinIds.attributeOptionIds,
      dayPrices:
        body.day_prices !== undefined
          ? parseDayPrices(body.day_prices)
          : existing.day_prices,
      groupIds:
        joinIds.groupIds === undefined
          ? await listingGroups.getIds(existing.id)
          : joinIds.groupIds,
      initialSiteMonths: existing.initial_site_months,
      maxAttendees,
      maxPrice: bodyNumber(body, "max_price", existing.max_price),
      monthsPerUnit: existing.months_per_unit,
      name: parsedName.value,
      purchaseOnly: existing.purchase_only,
      slug,
      slugIndex,
    } as ListingInput);
  });
};
