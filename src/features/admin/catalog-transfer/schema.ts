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
import { ListingTypeSchema } from "#shared/types.ts";

/** Bump when the format changes incompatibly; a blob at another version is
 * rejected with an intelligible message rather than mis-imported. */
export const CATALOG_TRANSFER_VERSION = 1;

/** A whole non-negative minor-unit price. */
const PriceSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
/** A whole non-negative integer (counts, day windows). */
const NonNegativeIntSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
/** A whole positive integer (durations, quantities). */
const PositiveIntSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
/** A required, trimmed, non-empty name reference. */
const NameRefSchema = v.pipe(v.string(), v.trim(), v.minLength(1));
/** Per-day-count price overrides as they appear in JSON (string day keys). */
const DayPricesSchema = v.record(v.string(), PriceSchema);

/**
 * The transferable columns of a listing, keyed in camelCase to match
 * `ListingInput`. Excludes the id/slug/timestamp columns (regenerated on
 * import) and the image/attachment columns (out of scope). Optional fields are
 * omitted rather than defaulted so the importing table applies its own column
 * defaults; `name` and `maxAttendees` are the only structural requirements.
 */
export const ListingDataSchema = v.object({
  active: v.optional(v.boolean()),
  assignBuiltSite: v.optional(v.boolean()),
  bookableDays: v.optional(v.array(v.string())),
  canPayMore: v.optional(v.boolean()),
  closesAt: v.optional(v.nullable(v.string())),
  customisableDays: v.optional(v.boolean()),
  date: v.optional(v.string()),
  dayPrices: v.optional(DayPricesSchema),
  description: v.optional(v.string()),
  durationDays: v.optional(PositiveIntSchema),
  fields: v.optional(v.string()),
  hidden: v.optional(v.boolean()),
  initialSiteMonths: v.optional(NonNegativeIntSchema),
  listingType: v.optional(ListingTypeSchema),
  location: v.optional(v.string()),
  maxAttendees: NonNegativeIntSchema,
  maximumDaysAfter: v.optional(NonNegativeIntSchema),
  maxPrice: v.optional(PriceSchema, 0),
  maxQuantity: v.optional(PositiveIntSchema),
  minimumDaysBefore: v.optional(NonNegativeIntSchema),
  monthsPerUnit: v.optional(NonNegativeIntSchema),
  name: NameRefSchema,
  nonTransferable: v.optional(v.boolean()),
  purchaseOnly: v.optional(v.boolean()),
  thankYouUrl: v.optional(v.string()),
  unitPrice: v.optional(PriceSchema),
  useDefaults: v.optional(v.boolean()),
  usesLogistics: v.optional(v.boolean()),
  webhookUrl: v.optional(v.string()),
});
export type ListingData = v.InferOutput<typeof ListingDataSchema>;

/** The transferable columns of a group, keyed to match `GroupInput` (members
 * live on the envelope, not here). */
export const GroupDataSchema = v.object({
  description: v.optional(v.string()),
  hidden: v.optional(v.boolean()),
  hidePackageListings: v.optional(v.boolean()),
  isPackage: v.optional(v.boolean()),
  maxAttendees: v.optional(NonNegativeIntSchema),
  name: NameRefSchema,
  termsAndConditions: v.optional(v.string()),
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
  const flat = v.flatten(issues);
  const parts: string[] = [];
  if (flat.root) parts.push(...flat.root);
  for (const [path, messages] of Object.entries(flat.nested ?? {})) {
    if (messages && messages.length > 0) {
      parts.push(`${path}: ${messages.join("; ")}`);
    }
  }
  if (flat.other) parts.push(...flat.other);
  return parts.length > 0
    ? `Invalid catalog file — ${parts.join("; ")}`
    : "Invalid catalog file — expected a listing or group export.";
};
