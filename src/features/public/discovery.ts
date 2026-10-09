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
  childOpen,
  parentAndChildFitGroup,
  type TicketListing,
} from "#booking/model.ts";
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
import { combinedChildCapacityForParent } from "#shared/capacity-fit.ts";
import { childIdsMatching } from "#shared/child-parents.ts";
import { getBookableStartDates } from "#shared/dates.ts";
import { sharedGroupCapacity } from "#shared/group-capacity.ts";
import type { ListingWithCount } from "#types";
import {
  childOfferedOnDate,
  childOfferedWithoutDate,
  childStartDates,
  parentOfferedDayCounts,
} from "./discovery/child-offered.ts";

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

/** A daily parent's own bookable start dates (its booking page's candidate
 * dates), against which a daily child's calendar must overlap. It is `null`
 * for a non-daily parent, which has NO date selector. Such a daily child
 * inherits no parent date, so no overlap applies: the child is judged by its
 * own calendar or fixed day count. */
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

/** The child as the ticket page sees it in this capacity context: the shared
 *  first line of every child gate below. */
const childInfoFor = (
  child: ListingWithCount,
  caps: ChildCapacityInfo,
): TicketListing =>
  buildTicketListing(
    child,
    isRegistrationClosed(child),
    caps.childOwnRemaining.get(child.id),
  );

/** Each child's date-invariant fold facts, computed once per parent: the
 *  child as the ticket page sees it, the pools it draws from, whether the
 *  pair fits its shared group's static cap, the child's own ceiling, and the
 *  child's bookable start dates. The per-date loop reads only what the date
 *  changes. */
type ChildFoldFacts = {
  childInfo: TicketListing;
  groupIds: number[];
  fitsGroup: boolean;
  ownMax: number;
  starts: string[];
};

const childFoldFactsFor = (
  parent: ListingWithCount,
  child: ListingWithCount,
  caps: ChildCapacityInfo,
  holidays: Holiday[],
): ChildFoldFacts => {
  const childInfo = childInfoFor(child, caps);
  const shared = sharedGroupCapacity(
    listingGroups.idsFor(caps.membership, parent.id),
    listingGroups.idsFor(caps.membership, child.id),
    caps.staticCapByGroupId,
    caps.remainingByGroupId,
  );
  return {
    childInfo,
    fitsGroup: parentAndChildFitGroup(shared),
    groupIds: listingGroups.idsFor(caps.membership, child.id),
    ownMax: childInfo.maxPurchasable,
    starts: childStartDates(childInfo, holidays),
  };
};

/** The child's own ceiling when the order starts on `date`, or zero when the
 *  child cannot fold on that date. A `null` date is the date-less gate: the
 *  child must fold on some date the parent offers, because the page carries
 *  no date selector. Children that fold on different dates must not sum: no
 *  single date can carry child units from calendars that never share one. */
const childOwnCeilingOnDate = (
  parentDates: ReadonlySet<string> | null,
  facts: ChildFoldFacts,
  holidays: Holiday[],
  dayCounts: (number | null)[],
  date: string | null,
): number => {
  if (!childActive(facts.childInfo) || !childOpen(facts.childInfo)) return 0;
  if (!facts.fitsGroup) return 0;
  if (date === null) {
    const offered = childOfferedWithoutDate(
      facts.childInfo,
      holidays,
      dayCounts,
      parentDates,
    );
    return offered ? facts.ownMax : 0;
  }
  const offered = childOfferedOnDate(
    facts.childInfo,
    holidays,
    dayCounts,
    facts.starts,
    date,
  );
  return offered ? facts.ownMax : 0;
};

/** The parent tickets a parent's children can serve together: the best
 *  feasible date and day count win. Children that fold on different dates
 *  must not sum — a minimum of three cannot take two units from a Monday-only
 *  child and two from a Tuesday-only child, because no single date carries
 *  both. The same rule binds day counts: the form books one count, so
 *  children that need different counts must not sum. A non-daily parent has
 *  no date selector, so one date-less evaluation answers. */
const combinedChildCapacity = (
  parent: ListingWithCount,
  children: readonly ListingWithCount[],
  caps: ChildCapacityInfo,
  holidays: Holiday[],
): number => {
  const dayCounts = parentOfferedDayCounts(parent);
  const parentDates = parentDatesOf(parent, holidays);
  const dates: (string | null)[] =
    parentDates === null ? [null] : [...parentDates];
  const facts = children.map((child) =>
    childFoldFactsFor(parent, child, caps, holidays),
  );
  // The date-less remaining map omits a group whose every member counts per
  // date. The static cap is the date-independent fact the pair check reads
  // when the remaining is unknown, so the allocation reads it too.
  const datelessRemaining = new Map([
    ...caps.staticCapByGroupId,
    ...caps.remainingByGroupId,
  ]);
  return Math.max(
    0,
    ...dates.flatMap((date) =>
      dayCounts.map((days) =>
        combinedChildCapacityForParent(
          listingGroups.idsFor(caps.membership, parent.id),
          facts.map((fact) => ({
            groupIds: fact.groupIds,
            ownMax: childOwnCeilingOnDate(
              parentDates,
              fact,
              holidays,
              [days],
              date,
            ),
          })),
          datelessRemaining,
        ),
      ),
    ),
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
  // The combined capacity answers once per parent: the add-on gate and the
  // sold-out loop both read it, and each call walks every offered date.
  const combinedByParentId = new Map<number, number>();
  const combinedFor = (parent: ListingWithCount): number => {
    const known = combinedByParentId.get(parent.id);
    if (known !== undefined) return known;
    const combined = combinedChildCapacity(
      parent,
      childrenByParent.get(parent.id) ?? [],
      caps,
      holidays,
    );
    combinedByParentId.set(parent.id, combined);
    return combined;
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
        combinedFor(p) >= p.min_quantity &&
        childOwnCeilingOnDate(
          parentDatesOf(p, holidays),
          childFoldFactsFor(p, child, caps, holidays),
          holidays,
          parentOfferedDayCounts(p),
          null,
        ) >= 1,
    );
  });
  const soldOutParentIds = new Set<number>();
  for (const [parentId] of childrenByParent) {
    const parent = listingById.get(parentId);
    // The parent must also reach its own minimum: children that together serve
    // fewer parent tickets than that minimum sell the parent nothing.
    const anyBookable =
      parent !== undefined && combinedFor(parent) >= parent.min_quantity;
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
      combinedChildCapacity(
        info.listing,
        children.map((c) => c.listing),
        caps,
        holidays,
      ) >= 1;
    if (children && children.length > 0 && !anyBookable) {
      return asSoldOut(info);
    }
    return info;
  });
