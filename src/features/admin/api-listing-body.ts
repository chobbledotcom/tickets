/** JSON body → ListingInput conversion for the admin listing API routes.
 *  Extracted from `api.ts` so that route file stays focused. */

import { listingGroups } from "#db/groups/table.ts";
import { getStoredListingWithCount } from "#db/listings/records.ts";
import {
  generateUniqueListingSlug,
  keepDailyListingDate,
  parseUpdatedListingSlug,
} from "#shared/listings-actions.ts";
import {
  LISTING_FIELDS,
  type ListingInput,
} from "#shared/records/listing-fields.ts";
import {
  parseOptionalArray,
  requireEntityField,
  requireStrings,
} from "#shared/rest/crud-parsers.ts";
import { readBody } from "#shared/rest/field-reads.ts";
import { type FieldsBody, fieldsOnDoor } from "#shared/rest/field-specs.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import {
  type AdminSession,
  type ListingWithCount,
  parseDayPrices,
} from "#types";

/** The listing fields the JSON API reads. */
const API_FIELDS = fieldsOnDoor(LISTING_FIELDS, "api");

/** The listing fields as one JSON write reads them. */
type ApiFields = Partial<ListingInput>;

/** JSON body accepted by POST /api/admin/listings. */
export type CreateListingBody = Omit<
  FieldsBody<typeof LISTING_FIELDS>,
  "date" | "day_prices"
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

/** Read the listing fields and the join-table id arrays before building the
 * listing input. Each field's kind carries its value rule, so a hand-built
 * body cannot set max_attendees 0 or a negative min_quantity. The read takes
 * the body after the editor lock strip, so a locked field keeps its stored
 * value or its column default. Attribute assignment is owner-only in the
 * dashboard: the listing choice post runs under OWNER_FORM and the attributes
 * resource under OWNER_API. The JSON field is therefore owner-only too. A
 * write that carries it without an owner session is refused, and one without
 * the field keeps the writer's normal listing access. An omitted id array
 * stays undefined: persistListingJoins skips the link write for it, so an
 * unrelated update never restores a stale set. `existing` is null on
 * create. */
const withParsedJoinIds = (
  session: AdminSession | undefined,
  body: Record<string, unknown>,
  existing: ListingWithCount | null,
  build: (fields: ApiFields) => Promise<Result<ListingInput>>,
): Promise<Result<ListingInput>> => {
  if (
    body.attribute_option_ids !== undefined &&
    session?.adminLevel !== "owner"
  ) {
    return Promise.resolve(errorResult("attribute_option_ids is owner-only"));
  }
  const fields = readBody(
    API_FIELDS,
    withoutEditorLockedFields(body, session),
    existing,
  );
  if (!fields.ok) return Promise.resolve(fields);
  const groupIds = parseOptionalIdArray(body.group_ids, "group_ids");
  if (!groupIds.ok) return Promise.resolve(groupIds);
  const attributeOptionIds = parseOptionalIdArray(
    body.attribute_option_ids,
    "attribute_option_ids",
  );
  if (!attributeOptionIds.ok) return Promise.resolve(attributeOptionIds);
  // The read keys each checked value by its input name.
  const read = fields.value as ApiFields;
  return build({
    ...read,
    attributeOptionIds: attributeOptionIds.value,
    dayPrices: parseDayPrices(read.dayPrices),
    groupIds: groupIds.value,
  });
};

/** The answer both listing write mappers give. */
type ListingWriteResult = Promise<Result<ListingInput>>;

/** Convert JSON body to ListingInput for create (auto-generates slug) */
export const bodyToCreateInput = async (
  body: Record<string, unknown>,
  _existing: null = null,
  session?: AdminSession,
): ListingWriteResult => {
  const nameField = requireStrings(body, ["name"]);
  if (!nameField.ok) return nameField;
  // Requiredness only. A supplied value's range is the field kind's value
  // rule, which the field read in withParsedJoinIds applies.
  if (typeof body.max_attendees !== "number") {
    return { error: "max_attendees is required", ok: false };
  }
  const name = nameField.value.name;
  const maxAttendees = body.max_attendees;

  return withParsedJoinIds(session, body, null, async (fields) => {
    const { slug, slugIndex } = await generateUniqueListingSlug();
    return okResult({
      ...fields,
      maxAttendees,
      maxPrice: fields.maxPrice ?? 0,
      name,
      slug,
      slugIndex,
    });
  });
};

/** Convert JSON body to ListingInput for update (merges with existing) */
export const bodyToUpdateInput = async (
  body: Record<string, unknown>,
  resolved: ListingWithCount,
  session?: AdminSession,
): ListingWriteResult => {
  const stored = await getStoredListingWithCount(resolved.id);
  const existing = stored === null ? resolved : stored;
  const parsedName = requireEntityField(body, "name", existing.name);
  if (!parsedName.ok) return parsedName;

  return withParsedJoinIds(session, body, existing, async (fields) => {
    const { slug, slugIndex } = await parseUpdatedListingSlug(
      body,
      existing.slug,
    );

    const input: ListingInput = {
      ...fields,
      // The JSON API cannot set these four fields, so fold the stored ones in
      // as the update's final facts. An update that adds groups or children
      // must read them the way the validators do, not as absent-and-false.
      assignBuiltSite: existing.assign_built_site,
      initialSiteMonths: existing.initial_site_months,
      maxAttendees: fields.maxAttendees ?? existing.max_attendees,
      maxPrice: fields.maxPrice ?? existing.max_price,
      monthsPerUnit: existing.months_per_unit,
      name: parsedName.value,
      purchaseOnly: existing.purchase_only,
      slug,
      slugIndex,
      // The validators judge the membership as it will stand after the write:
      // the submitted set, or the stored set when the body omits group_ids.
      wouldBeGroupIds:
        fields.groupIds ?? (await listingGroups.getIds(existing.id)),
    };
    return okResult({
      ...input,
      // The field read keeps the stored date when the body has none, and reads
      // a null date as empty. A daily listing's date must survive an
      // empty-date update, so the owner can switch the type back to standard
      // and get it back. The type itself can flip in this same update.
      date: keepDailyListingDate(fields.date, existing, input.listingType),
    });
  });
};
