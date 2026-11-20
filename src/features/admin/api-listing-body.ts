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
  LISTING_WRITE_KEYS,
  type ListingInput,
} from "#shared/records/listing-fields.ts";
import { closedFieldsFor } from "#shared/records/write-access.ts";
import { parseOptionalArray } from "#shared/rest/crud-parsers.ts";
import { readBody } from "#shared/rest/field-reads.ts";
import type { FieldsBody } from "#shared/rest/field-specs.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import {
  type AdminSession,
  type ListingWithCount,
  parseDayPrices,
} from "#types";

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
 * body cannot set max_attendees 0 or a negative min_quantity. A field that
 * the writer cannot set is refused, a link key included. Attribute assignment
 * is owner-only in the dashboard, and it needs the attributes feature. The
 * link key declares both rules. A write without the key keeps the writer's
 * normal listing access. An omitted id array
 * stays undefined: persistListingJoins skips the link write for it, so an
 * unrelated update never restores a stale set. `existing` is null on
 * create. */
const withParsedJoinIds = <Read extends ApiFields>(
  session: AdminSession | undefined,
  body: Record<string, unknown>,
  existing: ListingWithCount | null,
  build: (fields: Read) => Promise<Result<ListingInput>>,
): Promise<Result<ListingInput>> => {
  const fields = readBody(
    LISTING_FIELDS,
    body,
    existing,
    closedFieldsFor(LISTING_WRITE_KEYS, session?.adminLevel),
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
  const read = fields.value as Read;
  return build({
    ...read,
    attributeOptionIds: attributeOptionIds.value,
    dayPrices: parseDayPrices(read.dayPrices),
    groupIds: groupIds.value,
  });
};

/** The answer both listing write mappers give. */
type ListingWriteResult = Promise<Result<ListingInput>>;

/** A create read holds each required field. */
type CreateRead = ApiFields & { maxAttendees: number; name: string };

/** Convert JSON body to ListingInput for create (auto-generates slug) */
export const bodyToCreateInput = (
  body: Record<string, unknown>,
  _existing: null = null,
  session?: AdminSession,
): ListingWriteResult =>
  withParsedJoinIds<CreateRead>(session, body, null, async (fields) => {
    const { slug, slugIndex } = await generateUniqueListingSlug();
    return okResult({
      ...fields,
      maxPrice: fields.maxPrice ?? 0,
      slug,
      slugIndex,
    });
  });

/** An update read keeps the stored value of each field the body leaves out. */
type StoredRead = ApiFields & {
  date: string;
  maxAttendees: number;
  maxPrice: number;
  name: string;
};

/** Convert JSON body to ListingInput for update (merges with existing) */
export const bodyToUpdateInput = async (
  body: Record<string, unknown>,
  resolved: ListingWithCount,
  session?: AdminSession,
): ListingWriteResult => {
  const stored = await getStoredListingWithCount(resolved.id);
  const existing = stored === null ? resolved : stored;

  return withParsedJoinIds<StoredRead>(
    session,
    body,
    existing,
    async (fields) => {
      const { slug, slugIndex } = await parseUpdatedListingSlug(
        body,
        existing.slug,
      );

      const input: ListingInput = {
        ...fields,
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
    },
  );
};
