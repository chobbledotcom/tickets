/**
 * Re-validate a signed order's package structure and per-line pricing against
 * the CURRENT database, so a member added/removed, a price/quantity edited, or a
 * required child-edge changed mid-checkout is caught and fails the order closed
 * to a price_changed refund rather than booking a partial or stale bundle.
 *
 * Everything here is pure-ish re-derivation over the order's signed lines; the
 * IO (loading current members, children, hidden flags) sits in the small loaders
 * so the drift checks stay easy to test.
 */

import { uniqueBy } from "#fp";
import type { BookingIntent } from "#routes/api/webhook-types.ts";
import { buildBookingTree } from "#shared/booking/build-tree.ts";
import {
  buildTicketListing,
  type TicketListing,
} from "#shared/booking/model.ts";
import type { TreePackage } from "#shared/booking/page-packages.ts";
import {
  effectivePrice,
  NO_CUSTOM_PRICES,
  type PricedListing,
  packageMemberPriceRule,
} from "#shared/booking/price-tree.ts";
import {
  edgeDrifted,
  lineGroupId,
  lineGroupIds,
} from "#shared/booking/signed-metadata.ts";
import { childIdsMatching } from "#shared/child-parents.ts";
import {
  getPackageGroupById,
  loadPackageMemberPricing,
} from "#shared/db/groups.ts";
import {
  getChildrenForParents,
  getNonStandaloneChildIds,
  getParentsForChildren,
} from "#shared/db/listing-parents.ts";
import type { BookingItem } from "#shared/payments.ts";
import type { ListingWithCount } from "#shared/types.ts";

/** Total allocated units per child across the order's per-parent allocations
 * (a child chosen under two parents sums both legs). */
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
  /** The expected line total, or `null` to fail closed (a package line that is
   * no longer a valid member — forces a `price_changed` refund). */
  expectedPrice: number | null;
};

/** Current package-pricing state for a booking's group: which listings are
 * members and their non-zero overrides. Null when the booking isn't a package
 * (or the group was deleted / is no longer a package — those members then
 * revalidate against the base listing price, so a stale package price mismatches
 * and refunds via the normal path). */
export type PackagePricing = {
  memberIds: Set<number>;
  priceMap: Map<number, number>;
  /** Each member's CURRENT per-package quantity, to re-check the signed booked
   * quantity against an operator's mid-checkout edit. */
  quantityMap: Map<number, number>;
  /** Each customisable member's CURRENT per-day overrides (day count →
   * per-unit minor price), so a day-priced line revalidates against the same
   * override the checkout charged. */
  dayPriceMap: Map<number, Map<number, number>>;
};

/** Current package pricing for EACH group the order's lines were booked
 * through, keyed by group id. A group that no longer resolves (deleted /
 * un-packaged mid-checkout) is absent, so its lines fail closed in
 * {@link expectedItemPrice} and take the price_changed refund. */
export const loadPackagePricingByGroup = async (
  intent: BookingIntent,
): Promise<Map<number, PackagePricing>> => {
  const pricingByGroup = new Map<number, PackagePricing>();
  for (const groupId of lineGroupIds(intent.items)) {
    if ((await getPackageGroupById(groupId)) === null) continue;
    const pricing = await loadPackageMemberPricing(groupId);
    pricingByGroup.set(groupId, {
      dayPriceMap: pricing.dayPrices,
      memberIds: new Set(pricing.rows.map((r) => r.listing_id)),
      priceMap: pricing.prices,
      quantityMap: pricing.quantities,
    });
  }
  return pricingByGroup;
};

/** The expected line total for one item, or `null` to fail closed (force a
 * `price_changed` refund). Derives the line's {@link PriceRule} with the SAME
 * constructor the checkout tree and the webhook payload use
 * ({@link packageMemberPriceRule}) and evaluates it with the same
 * {@link effectivePrice}, so revalidation can never drift from what checkout
 * charged: a member's flat override (including an explicit free 0) > its
 * per-day override for the order's day count > the listing's own day/base
 * price. `lineGroupId` is the package THIS line was booked through (absent for
 * a standalone line); a line that is no longer a current member of that group
 * (package deleted, un-flagged, or the listing removed mid-checkout) fails
 * closed. */
export const expectedItemPrice = (
  pkg: PackagePricing | undefined,
  lineGroupId: number | undefined,
  foldedChildIds: ReadonlySet<number>,
  item: BookingItem,
  listing: PricedListing,
  dayCount: number,
): number | null => {
  // A folded child keeps its own base/day rule even when it is also a member;
  // a top-level package line must still be a member, else fail closed.
  const memberLine = lineGroupId !== undefined && !foldedChildIds.has(item.e);
  if (memberLine && !pkg?.memberIds.has(item.e)) return null;
  const rule = packageMemberPriceRule(
    memberLine ? pkg!.priceMap.get(item.e) : undefined,
    memberLine ? pkg!.dayPriceMap.get(item.e) : undefined,
    listing.customisable_days,
  );
  return effectivePrice(rule, listing, NO_CUSTOM_PRICES, dayCount) * item.q;
};

/**
 * Whether one package's signed lines no longer represent that CURRENT bundle,
 * forcing a price_changed refund (the buyer must never be booked for a partial
 * or stale bundle). `packageLines` are the order's top-level lines booked
 * through this package (folded children excluded); the bundle matches only when
 * they cover EXACTLY the current members and their quantities imply ONE common
 * positive package count at the current per-package quantities. Catches a
 * member added/removed mid-checkout, a member's quantity raised/lowered (so `q`
 * is no longer a whole number of packages), or quantities edited so the lines
 * no longer share a single count. Per-line price drift is handled separately by
 * {@link expectedItemPrice}/the price-mismatch pass.
 */
export const packageBundleMismatch = (
  pkg: PackagePricing,
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

/** Whether ANY booked package's lines drifted from its current bundle: each
 * group's member lines (by their own edge tags) are checked against that
 * group's own membership and per-package quantities
 * ({@link packageBundleMismatch}). */
export const anyPackageBundleMismatch = (
  pricingByGroup: ReadonlyMap<number, PackagePricing>,
  items: readonly BookingItem[],
): boolean =>
  [...pricingByGroup].some(([groupId, pkg]) =>
    packageBundleMismatch(
      pkg,
      items.filter((item) => lineGroupId(item) === groupId),
    ),
  );

/** Rebuild the order's booking tree from CURRENT config so the revalidation walk
 * can re-check each signed line's `nodeKey` still resolves. The top-level nodes
 * reuse the item rows already loaded this request; the required-child edges are
 * reloaded fresh, so a parent→child edge removed or swapped mid-checkout drops
 * that child's `nodeKey` from the tree. `nodeKey`s depend only on membership/edge
 * structure, not availability or price, so the rows are wrapped without
 * re-resolving capacity. */
/** Rebuild the order's booking tree from CURRENT config, then check whether the
 * signed lines no longer resolve against it — a required child (or package
 * member) whose edge the operator removed/swapped mid-checkout, or an edge ADDED
 * mid-checkout: a line's listing gained required children the signed order
 * carries no allocation for, so booking it would skip an add-on the current page
 * requires. Every order is walked against a fresh tree (a childless signed order
 * is exactly how an added edge presents). Package-membership and per-line price
 * drift are still caught by {@link packageBundleMismatch}/{@link
 * expectedItemPrice}.
 *
 * The tree's top-level nodes reuse the item rows already loaded this request; the
 * required-child edges are reloaded fresh, so a parent→child edge removed or
 * swapped mid-checkout drops that child's `nodeKey` from the tree. `nodeKey`s
 * depend only on membership/edge structure, not availability or price, so the
 * rows are wrapped without re-resolving capacity. */
export const orderEdgeDrifted = async (
  intent: BookingIntent,
  validatedItems: ValidatedItem[],
  pricingByGroup: ReadonlyMap<number, PackagePricing>,
): Promise<boolean> => {
  const allocatedByChild = allocatedUnitsByChild(intent);
  // A line leaves the top level only when EVERY unit folds under a parent. A
  // bookable-alone child bought beside its parent keeps ONE line whose surplus
  // (q beyond the allocated units) books standalone, so that line must build
  // its standalone node too — the drift walk revalidates the surplus against
  // it, and dropping it by id alone would refund the legitimate order.
  const fullyFolded = (listingId: number, quantity: number): boolean =>
    (allocatedByChild.get(listingId) ?? 0) >= quantity;
  // One resolved listing per id: a listing booked through two paths is two
  // lines but one listing row; the tree builder makes one node per path.
  const topLevel = uniqueBy((info: TicketListing) => info.listing.id)(
    validatedItems
      .filter((v) => !fullyFolded(v.item.e, v.item.q))
      .map((v) => buildTicketListing(v.listing, false, undefined)),
  );
  const childRows = await getChildrenForParents(
    topLevel.map((t) => t.listing.id),
  );
  const childrenByParentId = new Map(
    [...childRows].map(([parentId, rows]) => [
      parentId,
      rows.map((r) => buildTicketListing(r, false, undefined)),
    ]),
  );
  // Rebuild each booked package from CURRENT membership, scoped to the lines
  // the order actually tagged with it: a tagged line still a member keeps its
  // member `nodeKey`; one no longer a member builds standalone, so its signed
  // member key drops from the tree and the drift check fails it closed. An
  // UNTAGGED line always builds standalone — a listing that joined a (visible)
  // package mid-checkout was legitimately booked standalone and must not
  // drift; a listing with BOTH kinds of line (booked through a package AND on
  // its own) gets both nodes.
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
  const standaloneListingIds = new Set(
    nonFolded
      .filter((item) => lineGroupId(item) === undefined)
      .map((item) => item.e),
  );
  const tree = buildBookingTree({
    childrenByParentId,
    listings: topLevel,
    packages,
    slugs: [],
    standaloneListingIds,
  });
  return edgeDrifted(tree, intent.items, intent.allocations ?? []);
};

/**
 * Whether the order books any STANDALONE unit of a child that can no longer be
 * booked on its own — a child listing whose "can be booked by itself" flag was
 * cleared after this checkout session opened. Completing such a unit would create
 * a ticket whose `/ticket/<slug>` page now 404s at every fresh entry point, so it
 * is failed closed to a price_changed refund. The order-structure drift check
 * elsewhere only notices added/removed parent edges, not this flag flip, so it is
 * guarded here.
 *
 * A unit is standalone unless it is folded under one of the child's parents in
 * the same order. Folding happens two ways: an explicit per-parent allocation, or
 * — when the order carries no allocations — the child being listed alongside a
 * parent that adopts it. So a child's standalone unit count is its booked
 * quantity minus its allocated quantity, unless the whole quantity is adopted by
 * an in-order parent. Any positive standalone count on a now-non-standalone child
 * is stale.
 */
export const hasStaleStandaloneChild = async (
  intent: BookingIntent,
): Promise<boolean> => {
  const orderIds = intent.items.map((item) => item.e);
  const nonStandaloneChildIds = await getNonStandaloneChildIds(orderIds);
  if (nonStandaloneChildIds.size === 0) return false;
  const orderIdSet = new Set(orderIds);
  const allocatedByChild = allocatedUnitsByChild(intent);
  const parentsByChild = await getParentsForChildren([
    ...nonStandaloneChildIds,
  ]);
  const adoptedByInOrderParent = childIdsMatching(parentsByChild, (parents) =>
    parents.some((parent) => orderIdSet.has(parent.id)),
  );
  return intent.items.some((item) => {
    if (!nonStandaloneChildIds.has(item.e)) return false;
    const allocated = allocatedByChild.get(item.e) ?? 0;
    // Allocated units fold under their named parent; any surplus is standalone.
    // With no allocation, the whole quantity folds only if an in-order parent
    // adopts it — otherwise every unit is standalone.
    const standalone =
      allocated > 0
        ? item.q - allocated
        : adoptedByInOrderParent.has(item.e)
          ? 0
          : item.q;
    return standalone > 0;
  });
};
