/**
 * Decides which public booking links can be shown.
 *
 * Children cannot start a booking, so they never get their own public booking
 * link. Parents show as sold out when none of their required children can be
 * booked. The final date-specific check still happens when the buyer submits.
 *
 * The capacity and allocation facts the gates read live in
 * {@link ./discovery/combined-capacity.ts}. This module owns the
 * classification surfaces.
 */

import { buildTicketListing, type TicketListing } from "#booking/model.ts";
import {
  getGroupRemainingByListingId,
  getSharedGroupCapacities,
} from "#db/attendees/capacity/groups.ts";
import { listingGroups } from "#db/groups/table.ts";
import { getActiveHolidays, type Holiday } from "#db/holidays.ts";
import {
  getNonStandaloneChildIds,
  listingIdsWithLinks,
  loadParentAndChildLinks,
} from "#db/listing-parents.ts";
import { identity, mapById, mapNotNullish, unique } from "#fp";
import { isRegistrationClosed } from "#routes/format.ts";
import { childIdsMatching } from "#shared/child-parents.ts";
import type { ListingWithCount } from "#types";
import {
  type ChildCapacityInfo,
  childCapacityInfo,
  childJoinsMinimumBooking,
  combinedChildCapacity,
  evaluateParentPairs,
  type ParentPairEvaluation,
} from "./discovery/combined-capacity.ts";

/**
 * Four sets, because a child is treated differently by structure, by whether it
 * sells alone, and by whether any parent can still offer it:
 *
 * - `childIds` is structural. The group-liveness gate treats a flagged child as
 *   a non-member, so a group of only `bookable_alone` children is not live.
 * - `nonStandaloneChildIds` suppresses a call to action the booking entry point
 *   would reject anyway.
 * - `addOnChildIds` has at least one bookable parent. A child whose every
 *   parent is dead renders unavailable and never points at nothing.
 * - `soldOutParentIds` is judged on combined parent-and-child demand.
 */
export type DiscoveryClassification = {
  childIds: ReadonlySet<number>;
  nonStandaloneChildIds: ReadonlySet<number>;
  addOnChildIds: ReadonlySet<number>;
  soldOutParentIds: ReadonlySet<number>;
};

/** Whether a *parent* can currently offer its children as add-ons: its own
 * row must be active AND not sold out AND not registration-closed. A parent
 * that fails one of those three checks cannot fold a child into a booking. A
 * child whose only parents are all such has no live parent page to be offered
 * under — a dead end. Judged date-less (the parent's own row availability),
 * matching the rest of discovery. */
const parentBookable = (
  parent: ListingWithCount,
  groupRemaining: number | undefined,
): boolean => {
  if (!parent.active) return false;
  const info = buildTicketListing(
    parent,
    isRegistrationClosed(parent),
    groupRemaining,
  );
  return !info.isSoldOut && !info.isClosed;
};

/**
 * Classify the given listings for a discovery surface (see
 * {@link DiscoveryClassification}).
 *
 * `soldOutParentIds` contains a parent only when it has at least one child edge and
 * *none* of its children are bookable for the combined parent+child demand
 * — a parent with no edges is an ordinary listing, never forced sold
 * out here.
 */
export const classifyForDiscovery = async (
  listings: readonly ListingWithCount[],
): Promise<DiscoveryClassification> => {
  const ids = listings.map((l) => l.id);
  const [nonStandaloneChildIds, links] = await Promise.all([
    getNonStandaloneChildIds(ids),
    loadParentAndChildLinks(ids),
  ]);
  const { childrenByParent, parentIdsByChild, parentsByChild } = links;
  const childIds = listingIdsWithLinks(parentIdsByChild);
  const listingById = mapById(identity<ListingWithCount>)(listings);
  const everyChild = [...childrenByParent.values()].flat();
  // Displayed children whose add-on label we are deciding (keys of parentsByChild
  // are among the displayed `ids`, so they are in `listingById`). Their own group-remaining
  // is fetched for the combined-demand check below and unioned into the child map.
  const displayedChildren = mapNotNullish((id: number) => listingById.get(id))([
    ...parentsByChild.keys(),
  ]);
  const everyParent = [...parentsByChild.values()].flat();
  const allChildren = [...everyChild, ...displayedChildren];
  const [
    childCaps,
    childOwnRemaining,
    parentGroupRemaining,
    holidays,
    membership,
  ] = await Promise.all([
    getSharedGroupCapacities(allChildren),
    getGroupRemainingByListingId(allChildren),
    getGroupRemainingByListingId(everyParent),
    getActiveHolidays(),
    listingGroups.getIdsByKeys(
      unique([
        ...listingById.keys(),
        ...everyChild.map((c) => c.id),
        ...everyParent.map((p) => p.id),
      ]),
    ),
  ]);
  const caps = childCapacityInfo(childCaps, childOwnRemaining, membership);
  // A child is an add-on only when at least one parent is itself bookable AND
  // can offer THIS child given the *combined* parent+child group demand. Using
  // only `parentBookable` (the parent's own row) would mark a child available
  // while the parent's sold-out projection below reads the parent sold out,
  // leaving the note a dead end (e.g. a child whose only parent shares a
  // 1-spot capped group with it: one parent+child order needs two spots).
  // The evaluations answer once per parent: the add-on gate and the sold-out
  // loop both read them, and each evaluation walks every offered pair.
  const evaluationsByParentId = new Map<number, ParentPairEvaluation[]>();
  const evaluationsFor = (parent: ListingWithCount): ParentPairEvaluation[] => {
    const known = evaluationsByParentId.get(parent.id);
    if (known !== undefined) return known;
    const evaluations = evaluateParentPairs({
      caps,
      children: childrenByParent.get(parent.id) ?? [],
      holidays,
      parent,
    });
    evaluationsByParentId.set(parent.id, evaluations);
    return evaluations;
  };
  const addOnChildIds = childIdsMatching(parentsByChild, (parents, childId) => {
    // A `bookable_alone` child gets its own Book CTA rather than the add-on note,
    // so it never enters this set — otherwise `childCardState` would short-circuit
    // to "addon" before it could read as a normal standalone card.
    if (!nonStandaloneChildIds.has(childId)) return false;
    // childId comes from the displayed `ids`, so it is always present in `listingById`.
    const child = listingById.get(childId)!;
    return parents.some(
      (p) =>
        parentBookable(p, parentGroupRemaining.get(p.id)) &&
        childJoinsMinimumBooking(p, child, caps, holidays, evaluationsFor(p)),
    );
  });
  const soldOutParentIds = new Set<number>();
  for (const [parentId] of childrenByParent) {
    const parent = listingById.get(parentId);
    // The parent must also reach its own minimum: children that together serve
    // fewer parent tickets than that minimum sell the parent nothing.
    const anyBookable =
      parent !== undefined &&
      Math.max(
        0,
        ...evaluationsFor(parent).map((evaluation) => evaluation.combined),
      ) >= parent.min_quantity;
    if (!anyBookable) soldOutParentIds.add(parentId);
  }
  return { addOnChildIds, childIds, nonStandaloneChildIds, soldOutParentIds };
};

/** Force a {@link TicketListing} into the sold-out state (no Book CTA, no
 * purchasable quantity) — projecting a parent with no bookable child onto the
 * card/gallery state the booking gate will enforce. */
const asSoldOut = (info: TicketListing): TicketListing => ({
  ...info,
  isSoldOut: true,
  maxPurchasable: 0,
});

/** Apply the parent-sold-out classification to a list of {@link TicketListing}
 * (children are still returned — public cards keep the child's card and only
 * suppress its standalone CTA). A parent with no bookable child is projected to the
 * sold-out state. */
export const applyParentSoldOut = (
  listings: readonly TicketListing[],
  { soldOutParentIds }: DiscoveryClassification,
): TicketListing[] =>
  listings.map((info) =>
    soldOutParentIds.has(info.listing.id) ? asSoldOut(info) : info,
  );

/**
 * A parent with no bookable child renders sold out, rather than a form that can
 * only fail at submit. The authoritative date-specific rejection still happens
 * in the submit fold.
 *
 * The test uses combined parent-and-child demand: two of them in one capped
 * group consume two spots. That cap is date-independent, so a group too small
 * to hold both reads sold out even for a daily child. `holidays` judges a daily
 * child on its own calendar, so a child full on one date does not force its
 * parent sold out for every date.
 */
export const applyBookingPageParentSoldOut = (
  listings: readonly TicketListing[],
  childrenByParentId: ReadonlyMap<number, TicketListing[]>,
  caps: ChildCapacityInfo,
  holidays: Holiday[],
): TicketListing[] =>
  listings.map((info) => {
    const children = childrenByParentId.get(info.listing.id);
    const anyBookable =
      children !== undefined &&
      combinedChildCapacity({
        caps,
        children: children.map((c) => c.listing),
        holidays,
        parent: info.listing,
      }) >= 1;
    if (children && children.length > 0 && !anyBookable) {
      return asSoldOut(info);
    }
    return info;
  });
