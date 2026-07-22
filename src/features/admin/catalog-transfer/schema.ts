/**
 * The versioned, id-free JSON wire format for exporting/importing a single
 * listing or group ("catalog transfer").
 *
 * A blob is a discriminated union on `kind` (`"listing"` | `"group"`). It never
 * carries database ids — every cross-reference (a listing's parents and group
 * memberships, a group's member listings) is by **name**, since names are stable
 * across installs while ids are not. Images/attachments, ledger data, and
 * attendees are deliberately excluded: a transfer describes the catalog
 * structure and pricing, not the files or the money/booking history bound to one
 * install.
 *
 * This schema is the single source of truth for the format: it validates an
 * incoming blob at the import boundary (producing per-field messages via
 * {@link formatTransferIssues}) and types the objects the exporter builds.
 * Semantic validation beyond shape (name uniqueness, reference resolution, group
 * compatibility) happens in `import.ts` on top of a successful parse.
 */

import * as v from "valibot";
import { projectCatalogFields } from "#shared/catalog-fields/definition.ts";
import {
  groupCatalogFields,
  listingCatalogFields,
} from "#shared/catalog-fields/fields.ts";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import {
  isContactField,
  ListingTypeSchema,
  MAX_DURATION_DAYS,
} from "#shared/types.ts";
import { integerAtLeast } from "#shared/validation/number.ts";

/**
 * True when `value` is storable in a datetime column: empty (no value), or a
 * real calendar datetime — a naive `YYYY-MM-DDTHH:MM[:SS]` or an offset instant
 * (the exported shape). Impossible dates like `2026-02-30` are rejected (a bare
 * `Date` would silently roll them into March). Deliberately self-contained (no
 * Temporal/timezone import) so this early-loaded schema module stays free of the
 * settings-loading graph; it matches the strictness of the form's validator.
 */
const isStorableDatetime = (value: string): boolean => {
  if (value === "") return true;
  // Anchored end ($) so trailing junk ("…T00:00not-a-zone") is rejected rather
  // than silently emptied by the storage normaliser: optional seconds (with
  // optional fractional seconds only *after* seconds — "T00:00.123" is not a real
  // instant), and an optional Z / ±HH:MM offset are the only tails. The offset
  // hours/minutes are captured so an out-of-range offset ("+99:99") is rejected
  // too, not just range-checked on the local time.
  const m = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))?$/,
  );
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = m[6] === undefined ? 0 : Number(m[6]);
  const oh = m[7] === undefined ? 0 : Number(m[7]);
  const om = m[8] === undefined ? 0 : Number(m[8]);
  if (
    mo < 1 ||
    mo > 12 ||
    d < 1 ||
    h > 23 ||
    mi > 59 ||
    s > 59 ||
    oh > 23 ||
    om > 59
  ) {
    return false;
  }
  // Round-trip through UTC: a rolled-over impossible date won't match its parts.
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo - 1 &&
    dt.getUTCDate() === d
  );
};

/** A datetime column value: empty, or a real calendar datetime (see above). */
const DatetimeSchema = v.pipe(
  v.string(),
  v.check(isStorableDatetime, "must be a valid datetime"),
);

/** Bump when the format changes incompatibly; a blob at another version is
 * rejected with an intelligible message rather than mis-imported. */
export const CATALOG_TRANSFER_VERSION = 1;

/** A whole integer of at least `min`. Uses `safeInteger` (not just `integer`)
 * so an out-of-safe-range magnitude like `1e100` — which `Number.isInteger`
 * accepts — is a field error here rather than being rounded or throwing a raw
 * error at the storage layer, matching the form's money parser. */
/** A whole non-negative integer (counts, day windows, minor-unit prices). */
const NonNegativeIntSchema = integerAtLeast(0);
/** A whole positive integer (durations, quantities). */
const PositiveIntSchema = integerAtLeast(1);
/** A booking duration in whole days: 1..MAX_DURATION_DAYS, matching the listing
 * form's cap so an over-limit blob is a field error, not silently clamped. */
const DurationDaysSchema = v.pipe(
  integerAtLeast(1),
  v.maxValue(MAX_DURATION_DAYS, `must be at most ${MAX_DURATION_DAYS} days`),
);
/** A single valid contact-field name (email/phone/address/…). */
const ContactFieldSchema = v.custom<string>(
  (value) => typeof value === "string" && isContactField(value),
  "must be a known contact field",
);
/** The `fields` column: a comma-separated list of valid contact-field names, so
 * a typo ("fax") is a field error rather than a silently-dropped entry. */
const FieldsSchema = v.pipe(
  v.string(),
  v.transform((value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part),
  ),
  v.array(ContactFieldSchema),
  v.transform((parts) => parts.join(",")),
);
/** A bookable weekday name — validated so a typo ("Funday") is a field error
 * rather than a day that never matches an availability check. */
const BookableDaySchema = v.picklist(VALID_DAY_NAMES);
/** A minor-unit price — a non-negative integer. */
const PriceSchema = integerAtLeast(0);
/** A required, trimmed, non-empty name reference. */
const NameRefSchema = v.pipe(v.string(), v.trim(), v.minLength(1));
/** A day-count JSON key: a positive whole number within the bookable range, so a
 * typo key ("weekday") or an out-of-range count is a field error rather than a
 * silently-dropped override. */
const DayCountKeySchema = v.pipe(
  v.string(),
  v.regex(/^[1-9]\d*$/, "day count must be a positive whole number"),
  v.check(
    (key) => Number(key) <= MAX_DURATION_DAYS,
    `day count must be between 1 and ${MAX_DURATION_DAYS}`,
  ),
);
/** Per-day-count price overrides as they appear in JSON (validated string keys). */
const DayPricesSchema = v.record(DayCountKeySchema, PriceSchema);

// Reused optional-field shapes — aliased so the schemas below read as data and
// don't repeat the same `v.optional(...)` token runs (which the duplication gate
// flags across the parallel listing/group schemas).
const optString = v.optional(v.string());
const optBoolean = v.optional(v.boolean());
const optNonNegInt = v.optional(NonNegativeIntSchema);
const optPositiveInt = v.optional(PositiveIntSchema);

const TRANSFER_FIELD_SCHEMAS = {
  bookableDays: v.optional(v.array(BookableDaySchema)),
  boolean: optBoolean,
  datetime: v.optional(DatetimeSchema),
  dayPrices: v.optional(DayPricesSchema),
  durationDays: v.optional(DurationDaysSchema),
  fields: v.optional(FieldsSchema),
  listingType: v.optional(ListingTypeSchema),
  maxPrice: v.optional(PriceSchema, 0),
  name: NameRefSchema,
  nonNegativeInt: optNonNegInt,
  nullableDatetime: v.optional(v.nullable(DatetimeSchema)),
  positiveInt: optPositiveInt,
  price: v.optional(PriceSchema),
  requiredPositiveInt: PositiveIntSchema,
  string: optString,
} as const;

/**
 * The transferable columns of a listing, keyed in camelCase to match
 * `ListingInput`. Excludes the id/slug/timestamp columns (regenerated on
 * import) and the image/attachment columns (out of scope). Optional fields are
 * omitted rather than defaulted so the importing table applies its own column
 * defaults; `name` and `maxAttendees` are the only structural requirements.
 *
 * `strictObject` (here and in every transfer schema below): the format is
 * versioned and exact-version gated, so an unknown key is a mistake — a
 * misspelled field (`hidde`) or relationship key (`parent` for `parents`) is
 * rejected with a field error rather than silently dropped, which would
 * otherwise import a listing missing that column or its whole parent/group set.
 */
const ListingFieldsSchema = v.strictObject(
  projectCatalogFields(listingCatalogFields, "schema", TRANSFER_FIELD_SCHEMAS),
);

/** Drop day-price keys beyond the listing's own duration: the form only reads
 * `day_price_1..durationDays`, so a stored/blob entry above that (e.g. duration 2
 * with a "5" price) is inert and must not silently activate if the duration is
 * later raised. Filtered (not rejected) to mirror the form, which just ignores
 * the extra inputs. */
const filterDayPricesToDuration = (
  data: v.InferOutput<typeof ListingFieldsSchema>,
): v.InferOutput<typeof ListingFieldsSchema> => {
  if (!data.dayPrices) return data;
  const max = data.durationDays ?? 1;
  const dayPrices = Object.fromEntries(
    Object.entries(data.dayPrices).filter(([days]) => Number(days) <= max),
  );
  return { ...data, dayPrices };
};

export const ListingDataSchema = v.pipe(
  ListingFieldsSchema,
  v.transform(filterDayPricesToDuration),
);
export type ListingData = v.InferOutput<typeof ListingDataSchema>;

/** The transferable columns of a group, keyed to match `GroupInput` (members
 * live on the envelope, not here). */
export const GroupDataSchema = v.strictObject(
  projectCatalogFields(groupCatalogFields, "schema", TRANSFER_FIELD_SCHEMAS),
);
export type GroupData = v.InferOutput<typeof GroupDataSchema>;

/** The package-override fields a membership carries, from either side. `null`
 * `packagePrice` means "no override — use the listing's own price". */
const membershipOverrideEntries = {
  dayPrices: v.optional(DayPricesSchema),
  packagePrice: v.optional(v.nullable(PriceSchema)),
  quantity: v.optional(PositiveIntSchema),
};

/** A group a listing belongs to (listing-side view), referenced by group name. */
export const ListingMembershipSchema = v.strictObject({
  group: NameRefSchema,
  ...membershipOverrideEntries,
});
export type ListingMembership = v.InferOutput<typeof ListingMembershipSchema>;

/** A member of a group (group-side view), referenced by listing name. */
export const GroupMemberSchema = v.strictObject({
  listing: NameRefSchema,
  ...membershipOverrideEntries,
});
export type GroupMember = v.InferOutput<typeof GroupMemberSchema>;

const VersionSchema = v.literal(
  CATALOG_TRANSFER_VERSION,
  `Unsupported export version (expected ${CATALOG_TRANSFER_VERSION})`,
);

/** A listing export: the listing's own fields plus its group memberships (by
 * name) and its parent listings (by name). */
export const ListingTransferSchema = v.strictObject({
  groups: v.optional(v.array(ListingMembershipSchema), []),
  kind: v.literal("listing"),
  listing: ListingDataSchema,
  parents: v.optional(v.array(NameRefSchema), []),
  version: VersionSchema,
});
export type ListingTransfer = v.InferOutput<typeof ListingTransferSchema>;

/** A group export: the group's own fields plus its member listings (by name). */
export const GroupTransferSchema = v.strictObject({
  group: GroupDataSchema,
  kind: v.literal("group"),
  members: v.optional(v.array(GroupMemberSchema), []),
  version: VersionSchema,
});
export type GroupTransfer = v.InferOutput<typeof GroupTransferSchema>;

/** A catalog transfer blob: either a listing or a group export. */
export const CatalogTransferSchema = v.variant("kind", [
  ListingTransferSchema,
  GroupTransferSchema,
]);
export type CatalogTransfer = v.InferOutput<typeof CatalogTransferSchema>;

/**
 * Turn valibot parse issues into a single operator-facing message that names the
 * offending fields, so a malformed blob explains *which* field is missing or
 * invalid rather than surfacing a raw system error.
 */
export const formatTransferIssues = (
  issues: readonly [v.BaseIssue<unknown>, ...v.BaseIssue<unknown>[]],
): string => {
  // Every failure of these (object variant) schemas lands in `root` (the whole
  // blob is the wrong type) or `nested` (a keyed field is wrong), so those two
  // buckets always carry at least one message — no empty-parts fallback needed.
  const flat = v.flatten(issues);
  const parts = [
    ...(flat.root ?? []),
    ...Object.entries(flat.nested ?? {}).map(
      ([path, messages]) => `${path}: ${(messages as string[]).join("; ")}`,
    ),
  ];
  return `Invalid catalog file — ${parts.join("; ")}`;
};
