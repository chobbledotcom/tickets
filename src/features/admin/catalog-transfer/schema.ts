/**
 * The versioned, id-free JSON wire format for one listing or group.
 *
 * Cross-references are by **name**, never by database id, because names are
 * stable across installs and ids are not. Images, ledger data and attendees are
 * excluded: a transfer carries catalog structure and pricing, not the money or
 * files bound to one install. Validation beyond shape happens in `import.ts`.
 */

import * as v from "valibot";
import { GROUP_FIELDS } from "#shared/records/group-fields.ts";
import { LISTING_FIELDS } from "#shared/records/listing-fields.ts";
import {
  JsonDayPricesSchema,
  transferSchema,
} from "#shared/rest/field-values.ts";
import { integerAtLeast } from "#shared/validation/number.ts";

/** Bump when the format changes incompatibly. A blob at another version is
 * rejected with an intelligible message rather than mis-imported. */
export const CATALOG_TRANSFER_VERSION = 1;

/** A minor-unit price — a non-negative integer. */
const PriceSchema = integerAtLeast(0);
/** A required, trimmed, non-empty name reference. */
const NameRefSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());

/**
 * The transferable columns of a listing, keyed to match `ListingInput`. Each
 * field takes the value rule of its kind.
 *
 * `strictObject`, here and below, because the format is exact-version gated. A
 * misspelled key (`hidde`, or `parent` for `parents`) must fail rather than be
 * dropped. A drop imports a listing missing that column or its whole
 * parent/group set.
 */
const ListingFieldsSchema = transferSchema(LISTING_FIELDS);

/** Drop day-price keys beyond the listing's own duration: the form only reads
 * `day_price_1..durationDays`. A stored or blob entry above that (for
 * example, duration 2 with a "5" price) is inert. It must not activate if the
 * duration is later raised. Filtered (not rejected) to mirror the form, which
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
export const GroupDataSchema = transferSchema(GROUP_FIELDS);
export type GroupData = v.InferOutput<typeof GroupDataSchema>;

/** The package-override fields a membership carries, from either side. `null`
 * `packagePrice` means "no override — use the listing's own price". */
const membershipOverrideEntries = {
  dayPrices: v.optional(JsonDayPricesSchema),
  packagePrice: v.optional(v.nullable(PriceSchema)),
  quantity: v.optional(integerAtLeast(1)),
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
  const items = (raw as Record<string, unknown>)[kind];
  if (!Array.isArray(items)) return [];
  return items;
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
  const record = item as Record<string, unknown>;
  const body = record[kind === "listings" ? "listing" : "group"];
  if (typeof body !== "object" || body === null) return null;
  const name = (body as { name?: unknown }).name;
  if (typeof name !== "string") return null;
  return name.trim() === "" ? null : name;
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
