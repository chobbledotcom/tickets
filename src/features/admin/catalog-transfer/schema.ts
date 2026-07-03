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
import {
  isContactField,
  ListingTypeSchema,
  MAX_DURATION_DAYS,
} from "#shared/types.ts";

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
  // than silently emptied by the storage normaliser: optional seconds, optional
  // fractional seconds, and an optional Z / ±HH:MM offset are the only tails.
  const m = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/,
  );
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = m[6] === undefined ? 0 : Number(m[6]);
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return false;
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

/** A whole integer of at least `min`. */
const intAtLeast = (min: number) =>
  v.pipe(v.number(), v.integer(), v.minValue(min));
/** A whole non-negative integer (counts, day windows, minor-unit prices). */
const NonNegativeIntSchema = intAtLeast(0);
/** A whole positive integer (durations, quantities). */
const PositiveIntSchema = intAtLeast(1);
/** A booking duration in whole days: 1..MAX_DURATION_DAYS, matching the listing
 * form's cap so an over-limit blob is a field error, not silently clamped. */
const DurationDaysSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
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
const BookableDaySchema = v.picklist([
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
]);
/** A minor-unit price — a non-negative integer. */
const PriceSchema = intAtLeast(0);
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

/**
 * The transferable columns of a listing, keyed in camelCase to match
 * `ListingInput`. Excludes the id/slug/timestamp columns (regenerated on
 * import) and the image/attachment columns (out of scope). Optional fields are
 * omitted rather than defaulted so the importing table applies its own column
 * defaults; `name` and `maxAttendees` are the only structural requirements.
 */
export const ListingDataSchema = v.object({
  active: optBoolean,
  assignBuiltSite: optBoolean,
  bookableDays: v.optional(v.array(BookableDaySchema)),
  canPayMore: optBoolean,
  closesAt: v.optional(v.nullable(DatetimeSchema)),
  customisableDays: optBoolean,
  date: v.optional(DatetimeSchema),
  dayPrices: v.optional(DayPricesSchema),
  description: optString,
  durationDays: v.optional(DurationDaysSchema),
  fields: v.optional(FieldsSchema),
  hidden: optBoolean,
  initialSiteMonths: optNonNegInt,
  listingType: v.optional(ListingTypeSchema),
  location: optString,
  // A listing's capacity must be at least 1, matching the form/API create paths
  // (a 0-capacity listing can never accept a booking).
  maxAttendees: PositiveIntSchema,
  maximumDaysAfter: optNonNegInt,
  maxPrice: v.optional(PriceSchema, 0),
  maxQuantity: optPositiveInt,
  minimumDaysBefore: optNonNegInt,
  monthsPerUnit: optNonNegInt,
  name: NameRefSchema,
  nonTransferable: optBoolean,
  purchaseOnly: optBoolean,
  thankYouUrl: optString,
  unitPrice: v.optional(PriceSchema),
  useDefaults: optBoolean,
  usesLogistics: optBoolean,
  webhookUrl: optString,
});
export type ListingData = v.InferOutput<typeof ListingDataSchema>;

/** The transferable columns of a group, keyed to match `GroupInput` (members
 * live on the envelope, not here). */
export const GroupDataSchema = v.object({
  description: optString,
  hidden: optBoolean,
  hidePackageListings: optBoolean,
  isPackage: optBoolean,
  maxAttendees: optNonNegInt,
  name: NameRefSchema,
  termsAndConditions: optString,
});
export type GroupData = v.InferOutput<typeof GroupDataSchema>;

/** The package-override fields a membership carries, from either side. `null`
 * `packagePrice` means "no override — use the listing's own price". */
const membershipOverrideEntries = {
  dayPrices: v.optional(DayPricesSchema),
  packagePrice: v.optional(v.nullable(PriceSchema)),
  quantity: v.optional(PositiveIntSchema),
};

/** A group a listing belongs to (listing-side view), referenced by group name. */
export const ListingMembershipSchema = v.object({
  group: NameRefSchema,
  ...membershipOverrideEntries,
});
export type ListingMembership = v.InferOutput<typeof ListingMembershipSchema>;

/** A member of a group (group-side view), referenced by listing name. */
export const GroupMemberSchema = v.object({
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
export const ListingTransferSchema = v.object({
  groups: v.optional(v.array(ListingMembershipSchema), []),
  kind: v.literal("listing"),
  listing: ListingDataSchema,
  parents: v.optional(v.array(NameRefSchema), []),
  version: VersionSchema,
});
export type ListingTransfer = v.InferOutput<typeof ListingTransferSchema>;

/** A group export: the group's own fields plus its member listings (by name). */
export const GroupTransferSchema = v.object({
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
