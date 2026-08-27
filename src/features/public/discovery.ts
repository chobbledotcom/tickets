/**
 * Decides which public booking links can be shown.
 *
 * Children cannot start a booking, so they never get their own public booking
 * link. Parents show as sold out when none of their required children can be
 * booked. The final date-specific check still happens when the buyer submits.
 */

import {
  buildTicketListing,
  childActive,
  childHasDateOrStockForDays,
  childOpen,
  fixedParentDays,
  parentAndChildFitGroup,
  type TicketListing,
} from "#booking/model.ts";
import {
  getGroupRemainingByListingId,
  getSharedGroupCapacities,
} from "#db/attendees/capacity/groups.ts";
import { getHiddenPackageMemberIds, listingGroups } from "#db/groups.ts";
import { getActiveHolidays } from "#db/holidays.ts";
import {
  getNonStandaloneChildIds,
  listingIdsWithLinks,
  loadParentAndChildLinks,
} from "#db/listing-parents.ts";
import { identity, mapById, mapNotNullish, unique } from "#fp";
import { isRegistrationClosed } from "#routes/format.ts";
import { childIdsMatching } from "#shared/child-parents.ts";
import { getBookableStartDates } from "#shared/dates.ts";
import {
  availableDayCounts,
  type Holiday,
  type ListingWithCount,
  sharedGroupCapacity,
} from "#types";

/**
 * Drop members of a HIDDEN package from a buyer-facing listing set: such a
 * package promises buyers see only its name, never the individual members, so
 * the members must not appear as standalone cards/links/feed items on any
 * public surface. A no-op (and no query) when none of the listings are
 * hidden-package members. The package group itself is unaffected — its CTA is
 * gated separately by the shared group liveness loader.
 */
export const dropHiddenPackageMembers = async <T extends { id: number }>(
  listings: T[],
): Promise<T[]> => {
  const hidden = await getHiddenPackageMemberIds(listings.map((e) => e.id));
  return hidden.size === 0
    ? listings
    : listings.filter((e) => !hidden.has(e.id));
};

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

/** Checks whether a child can be offered before the buyer chooses a date. */
const childCanBeBooked = (
  child: TicketListing,
  holidays: Holiday[],
  parentDayCounts: (number | null)[],
  parentDates: ReadonlySet<string> | null,
): boolean =>
  childActive(child) &&
  childOpen(child) &&
  parentDayCounts.some((days) =>
    childHasDateOrStockForDays(holidays, days, parentDates)(child),
  );

/** Day counts the parent can pass to a daily child. */
const parentOfferedDayCounts = (parent: ListingWithCount): (number | null)[] =>
  parent.listing_type === "daily" && parent.customisable_days
    ? availableDayCounts(parent)
    : [fixedParentDays(parent)];

/** Whether a *parent* can currently offer its children as add-ons: its own
 * row must be active AND not sold out AND not registration-closed. An inactive/sold
 * out/closed parent cannot fold a child into a booking, so a child whose only
 * parents are all such has no live parent page to be offered under — a dead end.
 * Judged date-less (the parent's own row availability), matching the rest of
 * discovery. */
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

/** A daily parent's own bookable start dates (its booking page's candidate dates),
 * against which a daily child's calendar must overlap; `null` for a
 * non-daily parent, which has NO date selector — a daily child under it inherits no
 * parent date, so no overlap applies (the child is judged by its own calendar /
 * fixed day count). */
const parentDatesOf = (
  parent: ListingWithCount,
  holidays: Holiday[],
): ReadonlySet<string> | null =>
  parent.listing_type === "daily"
    ? new Set(getBookableStartDates(parent, holidays))
    : null;

/** Group facts needed to decide whether a parent can offer a child. */
export type ChildCapacityInfo = {
  childOwnRemaining: ReadonlyMap<number, number>;
  remainingByGroupId: ReadonlyMap<number, number>;
  staticCapByGroupId: ReadonlyMap<number, number>;
  membership: ReadonlyMap<number, number[]>;
};

/** Assemble the child-capacity facts the sold-out projection reads: each
 * child's own per-listing remaining (its sold-out state), the per-group shared
 * capacity/remaining, and group membership (which covers parents and children
 * alike, so it stands in for `childCaps.membership`). */
export const childCapacityInfo = (
  childCaps: Awaited<ReturnType<typeof getSharedGroupCapacities>>,
  childOwnRemaining: ReadonlyMap<number, number>,
  membership: ReadonlyMap<number, number[]>,
): ChildCapacityInfo => ({
  childOwnRemaining,
  membership,
  remainingByGroupId: childCaps.remaining,
  staticCapByGroupId: childCaps.staticCap,
});

/** Checks whether this parent can offer this child on public listing surfaces. */
const childCanBeBookedForParent = (
  parent: ListingWithCount,
  child: ListingWithCount,
  caps: ChildCapacityInfo,
  holidays: Holiday[],
): boolean => {
  const capacityFits = parentAndChildFitGroup(
    sharedGroupCapacity(
      listingGroups.idsFor(caps.membership, parent.id),
      listingGroups.idsFor(caps.membership, child.id),
      caps.staticCapByGroupId,
      caps.remainingByGroupId,
    ),
  );
  return (
    childCanBeBooked(
      buildTicketListing(
        child,
        isRegistrationClosed(child),
        caps.childOwnRemaining.get(child.id),
      ),
      holidays,
      parentOfferedDayCounts(parent),
      // A daily child must be bookable on a date the PARENT can serve, not merely on
      // its own calendar: else disjoint weekdays leave the parent advertised
      // while `getTicketContext`'s date union renders no valid date. A non-daily
      // parent has no date calendar (null), which the daily-only overlap test ignores
      // for a (necessarily standard) child.
      parentDatesOf(parent, holidays),
    ) && capacityFits
  );
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
  // A child is an add-on only when at least one parent is itself bookable AND can
  // offer THIS child given the *combined* parent+child group demand. Using only
  // `parentBookable` (the parent's own row) would mark a child
  // available while the parent's sold-out projection below (via childCanBeBookedForParent)
  // reads the parent sold out, leaving the note a dead end (e.g. a child whose only
  // parent shares a 1-spot capped group with it: one parent+child order needs two
  // spots). Reuse the same combined-demand check both surfaces use.
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
        childCanBeBookedForParent(p, child, caps, holidays),
    );
  });
  const soldOutParentIds = new Set<number>();
  for (const [parentId, children] of childrenByParent) {
    const parent = listingById.get(parentId);
    const anyBookable =
      parent !== undefined &&
      children.some((child) =>
        childCanBeBookedForParent(parent, child, caps, holidays),
      );
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
    const anyBookable = children?.some((child) =>
      childCanBeBookedForParent(info.listing, child.listing, caps, holidays),
    );
    if (children && children.length > 0 && !anyBookable) {
      return asSoldOut(info);
    }
    return info;
  });
