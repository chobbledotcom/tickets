import { resultRows, type TxScope } from "#db/client.ts";
import type { DayPriceRow } from "#db/listing-prices.ts";
import { pickedColumns } from "#db/picked-columns.ts";
import { records } from "#db/record-table.ts";
import { tableNode } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { sql, sqlList } from "#db/sql.ts";
import { refusingTheWriteOn } from "#db/transaction.ts";
import { requiredMapValue, unique } from "#fp";
import {
  childAddOnError,
  type EdgeListing,
  edgeFieldError,
  type ParentChildEdge,
  scopeIsChildDeadEnd,
} from "#shared/listing-parents-rules.ts";
import type { DayPrices } from "#types";

type EdgeListingRow = Omit<EdgeListing, "day_prices"> & {
  bookable_alone: boolean;
};

type AddOnScopeRow = {
  listing_id: number;
  modifier_id: number;
  name: string;
};

type CurrentEdgeListing = EdgeListing & { bookableAlone: boolean };

const listingById = (
  rows: EdgeListingRow[],
  prices: DayPriceRow[],
): Map<number, CurrentEdgeListing> => {
  const dayPrices = new Map<number, DayPrices>();
  for (const row of prices) {
    const listingPrices = dayPrices.get(row.listing_id) ?? {};
    listingPrices[Number(row.price_id)] = row.unit_price;
    dayPrices.set(row.listing_id, listingPrices);
  }
  return new Map(
    rows.map(
      ({ bookable_alone, ...listing }) =>
        [
          listing.id,
          {
            ...listing,
            bookableAlone: bookable_alone,
            day_prices: dayPrices.get(listing.id) ?? {},
          },
        ] as const,
    ),
  );
};

/** The add-on name of a scope read, which the client decodes. */
const ADD_ON_NAME = pickedColumns({
  name: tableNode(tables.modifiers, "modifier").name,
});

const relationshipError = (
  edge: ParentChildEdge,
  listings: Map<number, CurrentEdgeListing>,
  scopes: Map<number, AddOnScopeRow[]>,
): string | null => {
  const parent = requiredMapValue(
    listings,
    edge.parentId,
    `Listing ${edge.parentId} missing`,
  );
  const child = requiredMapValue(
    listings,
    edge.childId,
    `Listing ${edge.childId} missing`,
  );
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
const relationshipErrorTx = async (
  tx: TxScope,
  edges: readonly ParentChildEdge[],
): Promise<string | null> => {
  if (edges.length === 0) return null;
  const listingIds = unique(
    edges.flatMap(({ childId, parentId }) => [childId, parentId]),
  );
  const ids = sqlList(listingIds);
  const [listingResult, priceResult, scopeResult] = await tx.batch([
    records.listings
      .byId(listingIds)
      .pick(
        "id",
        "name",
        "listing_type",
        "months_per_unit",
        "customisable_days",
        "duration_days",
        "bookable_alone",
        "assign_built_site",
        "min_quantity",
      ),
    sql`SELECT listingPrice.listing_id, listingPrice.price_id,
                   listingPrice.unit_price
              FROM listing_prices AS listingPrice
             WHERE listingPrice.listing_id IN (${ids})
               AND listingPrice.price_type = 'day_count'`,
    ADD_ON_NAME.decoded(sql`WITH optionalModifier AS (
              SELECT modifier.id, modifier.name, modifier.scope
                FROM modifiers AS modifier
               WHERE modifier.active = 1 AND modifier.trigger = 'optional'
            )
            SELECT modifier.id AS modifier_id, ${ADD_ON_NAME.list},
                   modifierListing.listing_id
              FROM optionalModifier AS modifier
              JOIN modifier_listings AS modifierListing
                ON modifierListing.modifier_id = modifier.id
             WHERE modifier.scope = 'listings'
               AND modifierListing.listing_id IN (${ids})
            UNION
            SELECT modifier.id AS modifier_id, ${ADD_ON_NAME.list},
                   groupListing.listing_id
              FROM optionalModifier AS modifier
              JOIN modifier_groups AS modifierGroup
                ON modifierGroup.modifier_id = modifier.id
              JOIN group_listings AS groupListing
                ON groupListing.group_id = modifierGroup.group_id
             WHERE modifier.scope = 'groups'
               AND groupListing.listing_id IN (${ids})`),
  ]);
  const listings = listingById(
    resultRows<EdgeListingRow>(listingResult!),
    resultRows<DayPriceRow>(priceResult!),
  );
  const scopes = Map.groupBy(
    resultRows<AddOnScopeRow>(scopeResult!),
    (row) => row.modifier_id,
  );
  for (const edge of edges) {
    const error = relationshipError(edge, listings, scopes);
    if (error) return error;
  }
  return null;
};

export const requireCurrentRelationshipRules =
  refusingTheWriteOn(relationshipErrorTx);

/** Recheck every current edge touching a saved listing through the writer's
 * transaction, including edges another writer added after request validation. */
export const requireTouchingRelationshipsTx = async (
  tx: TxScope,
  listingId: number,
): Promise<void> => {
  const [childResult, parentResult] = await tx.batch([
    sql`SELECT listingParent.child_listing_id AS id
              FROM listing_parents AS listingParent
             WHERE listingParent.parent_listing_id = ${listingId}
             ORDER BY listingParent.child_listing_id`,
    sql`SELECT listingParent.parent_listing_id AS id
              FROM listing_parents AS listingParent
             WHERE listingParent.child_listing_id = ${listingId}
             ORDER BY listingParent.parent_listing_id`,
  ]);
  await requireCurrentRelationshipRules(tx, [
    ...resultRows<{ id: number }>(childResult!).map(({ id: childId }) => ({
      childId,
      parentId: listingId,
    })),
    ...resultRows<{ id: number }>(parentResult!).map(({ id: parentId }) => ({
      childId: listingId,
      parentId,
    })),
  ]);
};
