import { inPlaceholders, resultRows, type TxScope } from "#db/client.ts";
import type { DayPriceRow } from "#db/listing-prices.ts";
import { rawListingsTable } from "#db/listings/table.ts";
import { scopeIsChildDeadEnd } from "#db/modifier-resolve.ts";
import { modifiersTable } from "#db/modifiers.ts";
import { unique } from "#fp";
import {
  childAddOnError,
  type EdgeListing,
  edgeFieldError,
  type ParentChildEdge,
} from "#shared/listing-parents-rules.ts";
import type { DayPrices } from "#types";

type EdgeListingRow = Omit<EdgeListing, "day_prices"> & {
  bookable_alone: number;
};

type AddOnScopeRow = {
  listing_id: number;
  modifier_id: number;
  name: string;
};

type CurrentEdgeListing = EdgeListing & { bookableAlone: boolean };

const listingById = async (
  rows: EdgeListingRow[],
  prices: DayPriceRow[],
): Promise<Map<number, CurrentEdgeListing>> => {
  const dayPrices = new Map<number, DayPrices>();
  for (const row of prices) {
    const listingPrices = dayPrices.get(row.listing_id) ?? {};
    listingPrices[Number(row.price_id)] = row.unit_price;
    dayPrices.set(row.listing_id, listingPrices);
  }
  return new Map(
    await Promise.all(
      rows.map(
        async ({ bookable_alone, ...listing }) =>
          [
            listing.id,
            {
              ...listing,
              bookableAlone: bookable_alone === 1,
              day_prices: dayPrices.get(listing.id) ?? {},
              name: await rawListingsTable.readColumn(
                "name",
                listing.name,
                listing.id,
              ),
            },
          ] as const,
      ),
    ),
  );
};

const addOnScopes = async (
  rows: AddOnScopeRow[],
): Promise<Map<number, AddOnScopeRow[]>> =>
  Map.groupBy(
    await Promise.all(
      rows.map(async (row) => ({
        ...row,
        name: await modifiersTable.readColumn(
          "name",
          row.name,
          row.modifier_id,
        ),
      })),
    ),
    (row) => row.modifier_id,
  );

const relationshipError = (
  edge: ParentChildEdge,
  listings: Map<number, CurrentEdgeListing>,
  scopes: Map<number, AddOnScopeRow[]>,
): string | null => {
  const parent = listings.get(edge.parentId)!;
  const child = listings.get(edge.childId)!;
  const fieldError = edgeFieldError(parent, child);
  if (fieldError || child.bookableAlone) return fieldError;
  const blocked = [...scopes.values()].find((scope) =>
    scopeIsChildDeadEnd(
      scope.map((row) => row.listing_id),
      new Set([child.id]),
      new Set([parent.id]),
    ),
  );
  return blocked ? childAddOnError(blocked[0]!.name, child.name) : null;
};

/** Check current relationship fields and add-on scopes on the writer's open
 * transaction. The caller has already proved every endpoint exists. */
export const relationshipErrorTx = async (
  tx: TxScope,
  edges: readonly ParentChildEdge[],
): Promise<string | null> => {
  if (edges.length === 0) return null;
  const listingIds = unique(
    edges.flatMap(({ childId, parentId }) => [childId, parentId]),
  );
  const placeholders = inPlaceholders(listingIds);
  const [listingResult, priceResult, scopeResult] = await tx.batch([
    {
      args: listingIds,
      sql: `SELECT listing.id, listing.name, listing.listing_type,
                   listing.months_per_unit, listing.customisable_days,
                   listing.duration_days, listing.bookable_alone
              FROM listings AS listing
             WHERE listing.id IN (${placeholders})`,
    },
    {
      args: listingIds,
      sql: `SELECT listingPrice.listing_id, listingPrice.price_id,
                   listingPrice.unit_price
              FROM listing_prices AS listingPrice
             WHERE listingPrice.listing_id IN (${placeholders})
               AND listingPrice.price_type = 'day_count'`,
    },
    {
      args: [...listingIds, ...listingIds],
      sql: `WITH optionalModifier AS (
              SELECT modifier.id, modifier.name, modifier.scope
                FROM modifiers AS modifier
               WHERE modifier.active = 1 AND modifier.trigger = 'optional'
            )
            SELECT modifier.id AS modifier_id, modifier.name,
                   modifierListing.listing_id
              FROM optionalModifier AS modifier
              JOIN modifier_listings AS modifierListing
                ON modifierListing.modifier_id = modifier.id
             WHERE modifier.scope = 'listings'
               AND modifierListing.listing_id IN (${placeholders})
            UNION
            SELECT modifier.id AS modifier_id, modifier.name,
                   groupListing.listing_id
              FROM optionalModifier AS modifier
              JOIN modifier_groups AS modifierGroup
                ON modifierGroup.modifier_id = modifier.id
              JOIN group_listings AS groupListing
                ON groupListing.group_id = modifierGroup.group_id
             WHERE modifier.scope = 'groups'
               AND groupListing.listing_id IN (${placeholders})`,
    },
  ]);
  const listings = await listingById(
    resultRows<EdgeListingRow>(listingResult!),
    resultRows<DayPriceRow>(priceResult!),
  );
  const scopes = await addOnScopes(resultRows<AddOnScopeRow>(scopeResult!));
  for (const edge of edges) {
    const error = relationshipError(edge, listings, scopes);
    if (error) return error;
  }
  return null;
};
