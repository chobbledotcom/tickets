/**
 * Build the id-free JSON export for one listing or group (see schema.ts).
 *
 * The exporter reads the decrypted stored row and its related facets — group
 * memberships (with package overrides), parent listings, and per-day package
 * overrides — and renders every cross-reference by name. Prices come straight
 * off the listing columns (`unit_price`/`day_prices`); the derived
 * `listing_prices` mirror rows are re-synced from those on import, so they are
 * not exported separately.
 */

import * as v from "valibot";
import { mapNotNullish } from "#fp";
import {
  getAllGroupNames,
  getGroupPackagePrices,
  groups,
} from "#shared/db/groups.ts";
import { listingParents } from "#shared/db/listing-parents.ts";
import {
  getGroupDayPrices,
  getGroupDayPricesByGroupIds,
} from "#shared/db/listing-prices.ts";
import {
  getListingNamesByIds,
  getStoredListingWithCount,
  listingsTable,
} from "#shared/db/listings/records.ts";
import type { AdminLevel } from "#shared/types.ts";
import { getListingGroupMemberships } from "./membership.ts";
import {
  CATALOG_TRANSFER_VERSION,
  formatTransferIssues,
  GroupDataSchema,
  type GroupMember,
  type GroupTransfer,
  ListingDataSchema,
  type ListingMembership,
  type ListingTransfer,
} from "./schema.ts";

/** Returned (not thrown) when a stored row holds a value the transfer format
 * can't represent — e.g. a bookable-day name or contact field the admin JSON API
 * accepted but the transfer schema rejects. The export route surfaces it as an
 * operator-facing 4xx rather than letting a raw parse error become a 500. */
export class CatalogExportError extends Error {}

/** Project a stored row onto its transfer shape, or a {@link CatalogExportError}
 * (with an intelligible per-field message) when the row can't be represented. */
const parseExport = <TSchema extends v.GenericSchema>(
  schema: TSchema,
  value: unknown,
  what: string,
): v.InferOutput<TSchema> | CatalogExportError => {
  const result = v.safeParse(schema, value);
  if (result.success) return result.output;
  return new CatalogExportError(
    `This ${what} has a value that can't be exported — ${formatTransferIssues(result.issues)}`,
  );
};

/** Listing columns that never travel: the id/slug/timestamp columns (an import
 * mints fresh ones) and attachment columns (deliberately out of scope). Named
 * in snake_case for {@link listingsTable.rowToInput}. */
const LISTING_EXPORT_EXCLUDED = [
  "created",
  "slug",
  "slug_index",
  "attachment_url",
  "attachment_name",
] as const;

/** `webhook_url` receives attendee PII, so — like the edit form — it is hidden
 * from an editor; an editor's export must not reveal a URL they can't read. */
const EDITOR_EXPORT_EXCLUDED = [
  ...LISTING_EXPORT_EXCLUDED,
  "webhook_url",
] as const;

/** Group columns that never travel — the slug pair (regenerated on import). */
const GROUP_EXPORT_EXCLUDED = ["slug", "slug_index"] as const;

/** Convert a per-day override map to the JSON record shape, or undefined when
 * there are no overrides (so an empty map is omitted from the blob). */
const dayPricesToRecord = (
  dayPrices: ReadonlyMap<number, number> | undefined,
): Record<string, number> | undefined => {
  if (!dayPrices || dayPrices.size === 0) return;
  const record: Record<string, number> = {};
  for (const [day, price] of dayPrices) record[String(day)] = price;
  return record;
};

/** The package-override fields shared by both membership views, each omitted at
 * its neutral default (no price override, quantity 1, no per-day overrides) so a
 * plain membership serialises to just its name reference. */
const overrideFields = (
  packagePrice: number | null,
  quantity: number,
  dayPrices: ReadonlyMap<number, number> | undefined,
): {
  packagePrice?: number;
  quantity?: number;
  dayPrices?: Record<string, number>;
} => {
  const record = dayPricesToRecord(dayPrices);
  return {
    ...(packagePrice === null ? {} : { packagePrice }),
    ...(quantity === 1 ? {} : { quantity }),
    ...(record ? { dayPrices: record } : {}),
  };
};

/**
 * Build the JSON export for the listing with `id`, or null when it does not
 * exist. Reads the *stored* row (no operator defaults overlaid) so a re-import
 * preserves the listing's own columns.
 */
export const exportListing = async (
  id: number,
  adminLevel?: AdminLevel,
): Promise<ListingTransfer | CatalogExportError | null> => {
  const listing = await getStoredListingWithCount(id);
  if (!listing) return null;

  // `day_prices` is a projected column (its source rows live in `listing_prices`
  // now that the `listings.day_prices` column is retired), so `rowToInput` omits
  // it — carry it explicitly when the listing actually has per-day prices.
  const dayPrices =
    Object.keys(listing.day_prices).length > 0
      ? { dayPrices: listing.day_prices }
      : {};
  const listingData = parseExport(
    ListingDataSchema,
    {
      ...listingsTable.rowToInput(
        listing,
        adminLevel === "editor"
          ? EDITOR_EXPORT_EXCLUDED
          : LISTING_EXPORT_EXCLUDED,
      ),
      ...dayPrices,
    },
    "listing",
  );
  if (listingData instanceof CatalogExportError) return listingData;

  const [memberships, groupNames, parentIds] = await Promise.all([
    getListingGroupMemberships(id),
    getAllGroupNames(),
    listingParents.getIds(id),
  ]);
  const groupDayPrices = await getGroupDayPricesByGroupIds(
    memberships.map((m) => m.group_id),
  );

  // Every membership row references an existing group (FK), and `groupNames`
  // covers all groups, so the name lookup always resolves.
  const groupMemberships: ListingMembership[] = memberships.map((m) => ({
    group: groupNames.get(m.group_id)!,
    ...overrideFields(
      m.package_price,
      m.quantity,
      groupDayPrices.get(m.group_id)?.get(id),
    ),
  }));

  const parentNames = await getListingNamesByIds(parentIds);
  const parents = mapNotNullish((parentId: number) =>
    parentNames.get(parentId),
  )(parentIds);

  return {
    groups: groupMemberships,
    kind: "listing",
    listing: listingData,
    parents,
    version: CATALOG_TRANSFER_VERSION,
  };
};

/**
 * Build the JSON export for the group with `id`, or null when it does not
 * exist. Includes every member listing (by name) with its package override,
 * quantity, and per-day overrides.
 */
export const exportGroup = async (
  id: number,
): Promise<GroupTransfer | CatalogExportError | null> => {
  const group = await groups.table.findById(id);
  if (!group) return null;

  const groupData = parseExport(
    GroupDataSchema,
    groups.table.rowToInput(group, GROUP_EXPORT_EXCLUDED),
    "group",
  );
  if (groupData instanceof CatalogExportError) return groupData;

  const rows = await getGroupPackagePrices(id);
  const [listingNames, dayPrices] = await Promise.all([
    getListingNamesByIds(rows.map((r) => r.listing_id)),
    getGroupDayPrices(id),
  ]);

  // Every package row references an existing listing (FK), and `listingNames`
  // covers exactly those ids, so the name lookup always resolves.
  const members: GroupMember[] = rows.map((row) => ({
    listing: listingNames.get(row.listing_id)!,
    ...overrideFields(
      row.package_price,
      row.quantity,
      dayPrices.get(row.listing_id),
    ),
  }));

  return {
    group: groupData,
    kind: "group",
    members,
    version: CATALOG_TRANSFER_VERSION,
  };
};
