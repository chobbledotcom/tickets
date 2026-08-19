/**
 * Re-validate a signed order's package structure and per-line pricing against
 * the CURRENT database, so a member added/removed, a price/quantity edited, or a
 * required child-edge changed mid-checkout is caught and fails the order closed
 * to a price_changed refund rather than booking a partial or stale bundle.
 *
 * Everything here is pure re-derivation over the order's signed lines and the
 * current facts loaded by the paid-order snapshot.
 */

import { buildBookingTree } from "#booking/build-tree.ts";
import { buildTicketListing, type TicketListing } from "#booking/model.ts";
import type { TreePackage } from "#booking/page-packages.ts";
import {
  effectivePrice,
  NO_CUSTOM_PRICES,
  type PricedListing,
  packageMemberPriceRule,
} from "#booking/price-tree.ts";
import {
  edgeDrifted,
  lineGroupId,
  standaloneLineListingIds,
} from "#booking/signed-metadata.ts";
import { uniqueBy } from "#fp";
import type { BookingIntent, BookingItem } from "#shared/booking-intent.ts";
import { childIdsMatching } from "#shared/child-parents.ts";
import type { RegistrationPackagePricing } from "#shared/registration-package-facts.ts";
import type { ListingWithCount } from "#types";

const allocatedUnitsByChild = (intent: BookingIntent): Map<number, number> => {
  const allocatedByChild = new Map<number, number>();
  for (const allocation of intent.allocations ?? []) {
    const prior = allocatedByChild.get(allocation.childId) ?? 0;
    allocatedByChild.set(allocation.childId, prior + allocation.qty);
  }
  return allocatedByChild;
};

export type ValidatedItem = {
  item: BookingItem;
  listing: ListingWithCount;
  expectedPrice: number | null;
};

export const expectedItemPrice = (
  pkg: RegistrationPackagePricing | undefined,
  lineGroupId: number | undefined,
  foldedChildIds: ReadonlySet<number>,
  item: BookingItem,
  listing: PricedListing,
  dayCount: number,
): number | null => {
  const memberLine = lineGroupId !== undefined && !foldedChildIds.has(item.e);
  if (memberLine && !pkg?.memberIds.has(item.e)) return null;
  const rule = packageMemberPriceRule(
    memberLine ? pkg!.priceMap.get(item.e) : undefined,
    memberLine ? pkg!.dayPriceMap.get(item.e) : undefined,
    listing.customisable_days,
  );
  return effectivePrice(rule, listing, NO_CUSTOM_PRICES, dayCount) * item.q;
};

export const packageBundleMismatch = (
  pkg: RegistrationPackagePricing,
  packageLines: readonly BookingItem[],
): boolean => {
  if (packageLines.length !== pkg.memberIds.size) return true;
  const counts = new Set<number>();
  for (const line of packageLines) {
    if (!pkg.memberIds.has(line.e)) return true;
    const count = line.q / (pkg.quantityMap.get(line.e) ?? 1);
    if (!Number.isInteger(count) || count <= 0) return true;
    counts.add(count);
  }
  return counts.size > 1;
};

export const anyPackageBundleMismatch = (
  pricingByGroup: ReadonlyMap<number, RegistrationPackagePricing>,
  items: readonly BookingItem[],
): boolean =>
  [...pricingByGroup].some(([groupId, pkg]) =>
    packageBundleMismatch(
      pkg,
      items.filter((item) => lineGroupId(item) === groupId),
    ),
  );

export interface OrderRelationshipFacts {
  childIdsByParent: ReadonlyMap<number, number[]>;
  listingsById: ReadonlyMap<number, ListingWithCount>;
}

export const orderEdgeDriftedFromFacts = (
  intent: BookingIntent,
  validatedItems: ValidatedItem[],
  pricingByGroup: ReadonlyMap<number, RegistrationPackagePricing>,
  facts: OrderRelationshipFacts,
): boolean => {
  const allocatedByChild = allocatedUnitsByChild(intent);
  const fullyFolded = (listingId: number, quantity: number): boolean =>
    (allocatedByChild.get(listingId) ?? 0) >= quantity;
  const topLevel = uniqueBy((info: TicketListing) => info.listing.id)(
    validatedItems
      .filter((v) => !fullyFolded(v.item.e, v.item.q))
      .map((v) => buildTicketListing(v.listing, false, undefined)),
  );
  const childrenByParentId = new Map(
    topLevel.map(({ listing }) => [
      listing.id,
      (facts.childIdsByParent.get(listing.id) ?? []).map((childId) => {
        const child = facts.listingsById.get(childId);
        if (!child) throw new Error(`Missing linked listing ${childId}`);
        return buildTicketListing(child, false, undefined);
      }),
    ]),
  );
  const nonFolded = intent.items.filter((item) => !fullyFolded(item.e, item.q));
  const packages: TreePackage[] = [...pricingByGroup].map(([groupId, pkg]) => ({
    dayPrices: pkg.dayPriceMap,
    groupId,
    hideListings: false,
    memberListingIds: nonFolded
      .filter(
        (item) => lineGroupId(item) === groupId && pkg.memberIds.has(item.e),
      )
      .map((item) => item.e),
    prices: pkg.priceMap,
    quantities: pkg.quantityMap,
  }));
  const standaloneListingIds = new Set(standaloneLineListingIds(nonFolded));
  const tree = buildBookingTree({
    childrenByParentId,
    listings: topLevel,
    packages,
    slugs: [],
    standaloneListingIds,
  });
  return edgeDrifted(tree, intent.items, intent.allocations ?? []);
};

export const hasStaleStandaloneChildFromFacts = (
  intent: BookingIntent,
  nonStandaloneChildIds: ReadonlySet<number>,
  parentsByChild: ReadonlyMap<number, number[]>,
): boolean => {
  if (nonStandaloneChildIds.size === 0) return false;
  const orderIdSet = new Set(intent.items.map((item) => item.e));
  const allocatedByChild = allocatedUnitsByChild(intent);
  const adoptedByInOrderParent = childIdsMatching(parentsByChild, (parentIds) =>
    parentIds.some((parentId) => orderIdSet.has(parentId)),
  );
  return intent.items.some((item) => {
    if (!nonStandaloneChildIds.has(item.e)) return false;
    const allocated = allocatedByChild.get(item.e) ?? 0;
    const standalone =
      allocated > 0
        ? item.q - allocated
        : adoptedByInOrderParent.has(item.e)
          ? 0
          : item.q;
    return standalone > 0;
  });
};
