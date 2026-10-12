/**
 * The order gallery's catalog: the listing cards, the packages, and the
 * evaluator options for both. Each option carries the child demand the
 * booking form auto-folds.
 */

import {
  childSelectableForSpan,
  parentResolvedDuration,
  resolveChildSelections,
} from "#booking/fold-tree.ts";
import { membersWithChildren, type TicketListing } from "#booking/model.ts";
import {
  getGroupPackagePricesByGroupIds,
  packageMemberMaps,
} from "#db/groups.ts";
import { requiredMapValue, uniqueBy } from "#fp";
import { FormParams } from "#shared/form-data.ts";
import { isPublicListing } from "#shared/listing-visibility.ts";
import {
  listingOption,
  type OrderOption,
  packageOption,
} from "#shared/order/options.ts";
import { loadSortedListings } from "#shared/sort-listings.ts";
import { availableDayCounts, type Group, type ListingWithCount } from "#types";
import { allChildListings, loadChildrenByParentId } from "./child-listings.ts";
import { applyParentSoldOut, classifyForDiscovery } from "./discovery.ts";
import { loadBookablePackages } from "./group-liveness.ts";
import { buildTicketListingsWithGroupCapacity } from "./ticket-listings.ts";
import type { ChildrenByParentId } from "./types.ts";

/** Load the bookable listings for the order page, in the standard sorted order. */
const loadOrderListings = async (): Promise<ListingWithCount[]> =>
  (await loadSortedListings(isPublicListing)).listings;

/** One selectable package with everything its card and its option need. */
type OrderPackage = {
  group: Group;
  members: ListingWithCount[];
  /** How many units of each member one package books. */
  quantities: ReadonlyMap<number, number>;
};

/** Everything the order surfaces share: the listing cards, the packages, the
 * auto-folded children, and the option list the evaluator judges, in gallery
 * order. */
export type OrderCatalog = {
  ticketListings: TicketListing[];
  packages: OrderPackage[];
  /** The children the options auto-fold, so the pools carry the child
   * capacity that folded demand draws from. */
  childListings: ListingWithCount[];
  /** The shortest span a guaranteed fold occupies for each child. The pools
   * judge the child over the days that fold takes up. */
  foldSpanByChildId: ReadonlyMap<number, number>;
  options: OrderOption[];
};

/** The day counts the form can book one parent for. A customisable listing
 * offers each priced count. Everything else offers one fixed span. */
const parentBookableSpans = (parent: TicketListing): number[] =>
  parent.listing.customisable_days
    ? availableDayCounts(parent.listing)
    : [parentResolvedDuration(parent.listing, 1)];

/** The child units the form guarantees for one parent, and the shortest span
 * that fold occupies. A sole bookable child takes the whole quantity the
 * option books for that parent. The guarantee holds only when that same fold
 * resolves at every span the parent can be booked for.
 *
 * When some span folds differently (or no child is bookable there), the
 * buyer's choice decides and nothing is guaranteed. The form's own resolver
 * decides — an empty form says nothing was chosen yet, so only the auto-fill
 * can answer. */
const guaranteedFold = (
  parent: TicketListing,
  children: readonly TicketListing[],
  parentQty: number,
): { units: ReadonlyMap<number, number>; spanDays: number } | null => {
  const spans = parentBookableSpans(parent);
  const unitsAt = (span: number): ReadonlyMap<number, number> | null => {
    const selections = resolveChildSelections(
      parent,
      children.filter((child) => childSelectableForSpan(child, span)),
      parentQty,
      new FormParams(),
    );
    if ("error" in selections) return null;
    return new Map(
      selections.map(({ child, qty }): [number, number] => [
        child.listing.id,
        qty,
      ]),
    );
  };
  const folds = spans.map(unitsAt);
  const first = folds[0];
  if (!first) return null;
  const sameUnits = (units: ReadonlyMap<number, number> | null): boolean =>
    units !== null &&
    units.size === first.size &&
    [...first].every(([id, qty]) => units.get(id) === qty);
  if (!folds.every(sameUnits)) return null;
  return { spanDays: Math.min(...spans), units: first };
};

/** Charge one parent's guaranteed fold: return its units, and record the span
 * each charged child's fold occupies. The widest span wins, for a child
 * shared by parents that fold it over different spans. */
const chargedFoldUnits = (
  foldSpanByChildId: Map<number, number>,
  parent: TicketListing,
  children: readonly TicketListing[],
  parentQty: number,
): ReadonlyMap<number, number> => {
  const fold = guaranteedFold(parent, children, parentQty);
  if (fold === null) return new Map();
  for (const childId of fold.units.keys()) {
    const widest = foldSpanByChildId.get(childId);
    if (widest === undefined || fold.spanDays > widest) {
      foldSpanByChildId.set(childId, fold.spanDays);
    }
  }
  return fold.units;
};

/** The child units one package option auto-folds. Each member parent's sole
 * bookable child takes the member's per-package quantity. The fold sums a
 * child's units across members, as the form does. */
const foldedPackageChildUnits = (
  pkg: OrderPackage,
  childrenByParentId: ChildrenByParentId,
  parentInfoById: ReadonlyMap<number, TicketListing>,
  foldSpanByChildId: Map<number, number>,
): ReadonlyMap<number, number>[] => {
  const memberInfos: TicketListing[] = [];
  for (const member of pkg.members) {
    const message = `Package member ${member.id} left the catalog`;
    memberInfos.push(requiredMapValue(parentInfoById, member.id, message));
  }
  const pairs = membersWithChildren(memberInfos, childrenByParentId);
  const folds: ReadonlyMap<number, number>[] = [];
  for (const { member, children } of pairs) {
    const memberId = member.listing.id;
    const message = `Package member ${memberId} left the catalog`;
    const memberQty = requiredMapValue(pkg.quantities, memberId, message);
    folds.push(
      chargedFoldUnits(foldSpanByChildId, member, children, memberQty),
    );
  }
  return folds;
};

/** Add the folded child units to an option's demand, summing units when the
 * option already books that child (the form sums a child's lines too). */
const withFoldedChildren = (
  option: OrderOption,
  ...folds: readonly ReadonlyMap<number, number>[]
): OrderOption => {
  if (folds.every((fold) => fold.size === 0)) return option;
  const units = new Map(option.unitsByListingId);
  for (const fold of folds) {
    for (const [listingId, qty] of fold) {
      units.set(listingId, (units.get(listingId) ?? 0) + qty);
    }
  }
  return { ...option, unitsByListingId: units };
};

/** Load the order page's catalog: the selectable listing cards, bookable
 * packages with their members, the children the options auto-fold, and the
 * evaluator options for both. */
export const loadOrderCatalog = async (): Promise<OrderCatalog> => {
  const [listings, packageGroups] = await Promise.all([
    loadOrderListings(),
    loadBookablePackages(),
  ]);
  const [classification, priceRowsByGroupId] = await Promise.all([
    classifyForDiscovery(listings),
    getGroupPackagePricesByGroupIds(packageGroups.map(({ group }) => group.id)),
  ]);
  // Drop non-standalone children (not selectable). Then build the cards, and
  // project a parent to sold out when no child can be booked. A
  // `bookable_alone` child keeps its card and joins the cart like any listing.
  // When its parent reaches a booking page, alone or inside a package, the
  // form re-folds it there. The parent's child selector then chooses its
  // units.
  const offered = listings.filter(
    (e) => !classification.nonStandaloneChildIds.has(e.id),
  );
  const ticketListings = applyParentSoldOut(
    await buildTicketListingsWithGroupCapacity(offered),
    classification,
  );
  // A bookable bundle always has membership price rows.
  const packages = packageGroups.map(
    ({ group, members }): OrderPackage => ({
      group,
      members,
      quantities: packageMemberMaps(
        requiredMapValue(
          priceRowsByGroupId,
          group.id,
          `Package prices missing for group ${group.id}`,
        ),
      ).quantities,
    }),
  );
  // Every option's children load once here, so the evaluator can judge the
  // demand the form will fold: the units of a parent's sole bookable child.
  const memberListings = uniqueBy((listing: ListingWithCount) => listing.id)(
    packages.flatMap((pkg) => pkg.members),
  );
  const cardIds = new Set(ticketListings.map((info) => info.listing.id));
  const parentInfos = [
    ...ticketListings,
    ...(await buildTicketListingsWithGroupCapacity(
      memberListings.filter((listing) => !cardIds.has(listing.id)),
    )),
  ];
  const foldSpanByChildId = new Map<number, number>();
  const childrenByParentId = await loadChildrenByParentId(parentInfos);
  const parentInfoById = new Map(
    parentInfos.map((info): [number, TicketListing] => [info.listing.id, info]),
  );
  const options = [
    // Bookable packages lead the gallery. The shared package gate already
    // proved each whole bundle fits, so they are bookable alone.
    ...packages.map((pkg) =>
      withFoldedChildren(
        packageOption(pkg.group, pkg.members, pkg.quantities, true),
        ...foldedPackageChildUnits(
          pkg,
          childrenByParentId,
          parentInfoById,
          foldSpanByChildId,
        ),
      ),
    ),
    ...ticketListings.map((info) =>
      withFoldedChildren(
        listingOption(info.listing, !info.isSoldOut && !info.isClosed),
        chargedFoldUnits(
          foldSpanByChildId,
          info,
          childrenByParentId.get(info.listing.id) ?? [],
          info.listing.min_quantity,
        ),
      ),
    ),
  ];
  return {
    childListings: allChildListings(childrenByParentId),
    foldSpanByChildId,
    options,
    packages,
    ticketListings,
  };
};
