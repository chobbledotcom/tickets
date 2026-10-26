/**
 * The versioned, id-free JSON wire format for one listing or group.
 *
 * Cross-references are by **name**, never by database id, because names are
 * stable across installs and ids are not. Images, ledger data and attendees are
 * excluded: a transfer carries catalog structure and pricing, not the money or
 * files bound to one install. Validation beyond shape happens in `import.ts`.
 */

import * as v from "valibot";
import { projectCatalogFields } from "#shared/catalog-fields/definition.ts";
import {
  groupCatalogFields,
  listingCatalogFields,
} from "#shared/catalog-fields/fields.ts";
import { fieldsSchema } from "#shared/catalog-fields/fields-schema.ts";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import { integerAtLeast } from "#shared/validation/number.ts";
import { ListingTypeSchema, MAX_DURATION_DAYS } from "#types";

/**
 * True when `value` is storable in a datetime column: empty (no value), or a
 * real calendar datetime — a naive `YYYY-MM-DDTHH:MM[:SS]` or an offset instant
 * (the exported shape). Impossible dates like `2026-02-30` are rejected (a bare
 * `Date` silently rolls them into March). The code is deliberately
 * self-contained (no Temporal/timezone import) so this early-loaded schema
 * module stays free of the settings-loading graph. It matches the strictness
 * of the form's validator.
 */
const isStorableDatetime = (value: string): boolean => {
  if (value === "") return true;
  // Anchored end ($) so trailing junk ("…T00:00not-a-zone") is rejected rather
  // than silently emptied by the storage normaliser. The only tails are
  // optional seconds (with optional fractional seconds only *after* seconds —
  // "T00:00.123" is not a real instant) and an optional Z / ±HH:MM offset. The
  // offset hours/minutes are captured so an out-of-range offset ("+99:99") is
  // rejected too, not just range-checked on the local time.
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
  // Round-trip through UTC: a rolled-over impossible date does not match its parts.
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

/** Bump when the format changes incompatibly. A blob at another version is
 * rejected with an intelligible message rather than mis-imported. */
export const CATALOG_TRANSFER_VERSION = 1;

/** A whole integer of at least `min`. Uses `safeInteger` (not just `integer`).
 * An out-of-safe-range magnitude like `1e100` is then a field error here rather
 * than being rounded or throwing a raw error at the storage layer. The choice
 * matches the form's money parser. `Number.isInteger` accepts `1e100`. */
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
/** A bookable weekday name — validated so a typo ("Funday") is a field error
 * rather than a day that never matches an availability check. */
const BookableDaySchema = v.picklist(VALID_DAY_NAMES);
/** A minor-unit price — a non-negative integer. */
const PriceSchema = integerAtLeast(0);
/** A required, trimmed, non-empty name reference. */
const NameRefSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());
/** A day-count JSON key: a positive whole number within the bookable range. A
 * typo key ("weekday") or an out-of-range count is then a field error rather
 * than a silently-dropped override. */
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

// Reused optional-field shapes — aliased so the schemas below read as data.
// They do not repeat the same `v.optional(...)` token runs (which the
// duplication gate flags across the parallel listing/group schemas).
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
  fields: v.optional(fieldsSchema),
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
 * Optional fields are omitted rather than defaulted, so the importing table
 * applies its own column defaults.
 *
 * `strictObject`, here and below, because the format is exact-version gated. A
 * misspelled key (`hidde`, or `parent` for `parents`) must fail rather than be
 * dropped. A drop imports a listing missing that column or its whole
 * parent/group set.
 */
const ListingFieldsSchema = v.strictObject(
  projectCatalogFields(listingCatalogFields, "schema", TRANSFER_FIELD_SCHEMAS),
);

/** Drop day-price keys beyond the listing's own duration. The form only
 * reads `day_price_1..durationDays`. A stored/blob entry above that (for
 * example duration 2 with a "5" price) is inert and must not silently
 * activate if the duration rises later. The filter mirrors the form, which
 * just ignores the extra inputs. */
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

/** One listing inside a bundle: the listing's own fields plus its group
 * memberships (by name) and its parent listings (by name). The single-file
 * listing blob is this body plus its envelope (`kind`, `version`). */
export const ListingBodySchema = v.strictObject({
  groups: v.optional(v.array(ListingMembershipSchema), []),
  listing: ListingDataSchema,
  parents: v.optional(v.array(NameRefSchema), []),
});
export type ListingBody = v.InferOutput<typeof ListingBodySchema>;

/** A listing export: the listing's own fields plus its group memberships (by
 * name) and its parent listings (by name). */
export const ListingTransferSchema = v.strictObject({
  kind: v.literal("listing"),
  version: VersionSchema,
  ...ListingBodySchema.entries,
});
export type ListingTransfer = v.InferOutput<typeof ListingTransferSchema>;

/** One group inside a bundle: the group's own fields plus its member listings
 * (by name). The single-file group blob is this body plus its envelope. */
export const GroupBodySchema = v.strictObject({
  group: GroupDataSchema,
  members: v.optional(v.array(GroupMemberSchema), []),
});
export type GroupBody = v.InferOutput<typeof GroupBodySchema>;

/** A group export: the group's own fields plus its member listings (by name). */
export const GroupTransferSchema = v.strictObject({
  group: GroupBodySchema.entries.group,
  kind: v.literal("group"),
  members: GroupBodySchema.entries.members,
  version: VersionSchema,
});
export type GroupTransfer = v.InferOutput<typeof GroupTransferSchema>;

/** A catalog bundle: many listings and groups in one document. Every
 * cross-reference is by name. It resolves inside the document first, then
 * against the importing site. One file can thus carry a whole subtree the
 * target does not hold yet. */
export const CatalogBundleSchema = v.pipe(
  v.strictObject({
    groups: v.optional(v.array(GroupBodySchema), []),
    kind: v.literal("bundle"),
    listings: v.optional(v.array(ListingBodySchema), []),
    version: VersionSchema,
  }),
  v.check(
    (bundle) => bundle.listings.length + bundle.groups.length > 0,
    "The bundle holds no listings and no groups — add at least one item.",
  ),
);
export type CatalogBundle = v.InferOutput<typeof CatalogBundleSchema>;

/** A catalog transfer blob: one listing, one group, or a bundle of many. */
export const CatalogTransferSchema = v.variant("kind", [
  ListingTransferSchema,
  GroupTransferSchema,
  CatalogBundleSchema,
]);
export type CatalogTransfer = v.InferOutput<typeof CatalogTransferSchema>;

/** The parse issues valibot reports for one rejected blob. */
type TransferIssues = readonly [
  v.BaseIssue<unknown>,
  ...v.BaseIssue<unknown>[],
];

/** The one operator-facing opening for a rejected catalog file, shared by the
 * single-blob and bundle formatters. */
const catalogFileError = (parts: readonly string[]): string =>
  `Invalid catalog file — ${parts.join("; ")}`;

/**
 * Turn valibot parse issues into a single operator-facing message that names
 * the offending fields. A malformed blob then explains *which* field is
 * missing or invalid rather than surfacing a raw system error.
 */
export const formatTransferIssues = (issues: TransferIssues): string => {
  // Every failure of these (object variant) schemas lands in `root` (the whole
  // blob is the wrong type) or `nested` (a keyed field is wrong). Those two
  // buckets always carry at least one message — no empty-parts fallback needed.
  const flat = v.flatten(issues);
  const parts = [
    ...(flat.root ?? []),
    ...Object.entries(flat.nested ?? {}).map(
      ([path, messages]) => `${path}: ${(messages as string[]).join("; ")}`,
    ),
  ];
  return catalogFileError(parts);
};

/** The submitted items of one kind, when the raw document holds an array. */
const rawItemsOf = (raw: unknown, kind: "listings" | "groups"): unknown[] => {
  if (typeof raw !== "object" || raw === null) return [];
  if (kind === "listings" && "listings" in raw && Array.isArray(raw.listings)) {
    return raw.listings;
  }
  if (kind === "groups" && "groups" in raw && Array.isArray(raw.groups)) {
    return raw.groups;
  }
  return [];
};

/** Read one segment of a raw bundle item: the item's name, when the raw
 * document carries one. The parse failed, so no parsed output exists. The
 * name comes straight from the submitted JSON. */
const rawBundleItemName = (
  raw: unknown,
  kind: "listings" | "groups",
  index: number,
): string | null => {
  const item = rawItemsOf(raw, kind)[index];
  if (typeof item !== "object" || item === null) return null;
  // A bundle item holds its name in the nested body ("listing": {...name}).
  const body =
    kind === "listings" && "listing" in item && typeof item.listing === "object"
      ? item.listing
      : kind === "groups" && "group" in item && typeof item.group === "object"
        ? item.group
        : undefined;
  if (body === undefined || body === null || !("name" in body)) return null;
  const name = body.name;
  return typeof name === "string" && name.trim() !== "" ? name : null;
};

/**
 * Turn bundle parse issues into one operator-facing message that names each
 * failing item and its invalid field. The item name comes from the raw
 * document through the issue's path index. An item whose own name field
 * failed reports by position (listing 2), because no name exists to show.
 */
export const formatBundleIssues = (
  issues: TransferIssues,
  raw: unknown,
): string => {
  const parts = issues.map((issue) => {
    const keys = (issue.path ?? []).map((step) => step.key);
    const kind = keys[0];
    if (
      (kind === "listings" || kind === "groups") &&
      typeof keys[1] === "number"
    ) {
      const noun = kind === "listings" ? "listing" : "group";
      const name = rawBundleItemName(raw, kind, keys[1]);
      const where = name ?? `${noun} ${Number(keys[1]) + 1}`;
      const field = keys.slice(2).map(String).join(".");
      return field === ""
        ? `"${where}": ${issue.message}`
        : `"${where}": ${field}: ${issue.message}`;
    }
    return issue.message;
  });
  return catalogFileError([...new Set(parts)]);
};
