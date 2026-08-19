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

/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import { getAllGroupNames, getGroupPackagePrices } from "#db/groups.ts";
import { listingParents } from "#db/listing-parents.ts";
import {
  getGroupDayPrices,
  getGroupDayPricesByGroupIds,
} from "#db/listing-prices.ts";
import {
  getStoredListingWithCount,
  listingNames,
} from "#db/listings/records.ts";
import { mapNotNullish } from "#fp";
import { withGroupOrNull } from "#routes/admin/find-group.ts";
import { projectCatalogFields } from "#shared/catalog-fields/definition.ts";
import {
  groupCatalogFields,
  listingCatalogFields,
} from "#shared/catalog-fields/fields.ts";
import { namedError } from "#shared/named-error.ts";
import type { AdminLevel } from "#types";
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
/* jscpd:ignore-end */

/** Returned (not thrown) when a stored row holds a value the transfer format
 * can't represent — e.g. a bookable-day name or contact field the admin JSON API
 * accepted but the transfer schema rejects. The export route surfaces it as an
 * operator-facing 4xx rather than letting a raw parse error become a 500. */
export class CatalogExportError extends namedError("CatalogExportError") {}

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

/** Convert a per-day override map to the JSON record shape, or undefined when
 * there are no overrides (so an empty map is omitted from the blob). */
const dayPricesToRecord = (
  dayPrices: ReadonlyMap<number, number> | undefined,
): Record<string, number> | undefined => {
  if (!dayPrices || dayPrices.size === 0) return;
  return Object.fromEntries(dayPrices);
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

  const listingData = parseExport(
    ListingDataSchema,
    projectCatalogFields(
      listingCatalogFields,
      "transfer",
      listing,
      adminLevel === "editor" ? ["webhookUrl"] : [],
    ),
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

  const parentNames = await listingNames.byIds(parentIds);
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
export const exportGroup = (
  id: number,
): Promise<GroupTransfer | CatalogExportError | null> =>
  withGroupOrNull(id, async (group) => {
    const groupData = parseExport(
      GroupDataSchema,
      projectCatalogFields(groupCatalogFields, "transfer", group),
      "group",
    );
    if (groupData instanceof CatalogExportError) return groupData;

    const rows = await getGroupPackagePrices(id);
    const [namesByListing, dayPrices] = await Promise.all([
      listingNames.byIds(rows.map((r) => r.listing_id)),
      getGroupDayPrices(id),
    ]);

    // Every package row references an existing listing (FK), and `namesByListing`
    // covers exactly those ids, so the name lookup always resolves.
    const members: GroupMember[] = rows.map((row) => ({
      listing: namesByListing.get(row.listing_id)!,
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
  });
