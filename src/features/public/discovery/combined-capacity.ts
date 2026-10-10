/** The combined capacity of one parent's children across the pairs the
 *  parent offers, and the per-child gate behind the add-on label.
 *
 *  A parent ticket takes one place in each capped group the parent belongs
 *  to. Each required child line takes one place in each capped group that
 *  child belongs to. The exact search over a set of children lives in
 *  {@link #shared/capacity-fit.ts}. This module folds the children's own
 *  gates and dates into it, once per offered (date, day count) pair. */

/* jscpd:ignore-start */
import {
  buildTicketListing,
  childActive,
  childOpen,
  parentAndChildFitGroup,
  type TicketListing,
} from "#booking/model.ts";
import type { getSharedGroupCapacities } from "#db/attendees/capacity/groups.ts";
import { listingGroups } from "#db/groups/table.ts";
import type { Holiday } from "#db/holidays.ts";
import { isRegistrationClosed } from "#routes/format.ts";
import {
  type ChildCapacityPart,
  combinedChildCapacityForParent,
} from "#shared/capacity-fit.ts";
import { getBookableStartDates } from "#shared/dates.ts";
import { sharedGroupCapacity } from "#shared/group-capacity.ts";
import type { ListingWithCount } from "#types";
import {
  childOfferedOnDate,
  childOfferedWithoutDate,
  childStartDates,
  parentOfferedDayCounts,
} from "./child-offered.ts";
/* jscpd:ignore-end */

/** Group facts needed to decide whether a parent can offer a child. */
export type ChildCapacityInfo = {
  childOwnRemaining: ReadonlyMap<number, number>;
  remainingByGroupId: ReadonlyMap<number, number>;
  staticCapByGroupId: ReadonlyMap<number, number>;
  membership: ReadonlyMap<number, number[]>;
};

/** Assemble the child-capacity facts the sold-out projection reads: each
 * child's own per-listing remaining (its sold-out state), the per-group shared
 * capacity/remaining, and group membership. The membership covers parents and
 * children alike, so it stands in for `childCaps.membership`. */
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

/** Each child's date-invariant fold facts, computed once per parent. They
 *  hold the child as the ticket page sees it, the pools it draws from, and
 *  whether the pair fits its shared group's static cap. They also hold the
 *  child's own ceiling and its bookable start dates. The per-date loop
 *  reads only what the date changes. */
type ChildFoldFacts = {
  childInfo: TicketListing;
  groupIds: number[];
  fitsGroup: boolean;
  ownMax: number;
  starts: string[];
};

/** The fixed facts one parent's fold checks read: the parent, one of its
 *  children, and the group and calendar context. */
type ChildFoldCtx = {
  parent: ListingWithCount;
  child: ListingWithCount;
  caps: ChildCapacityInfo;
  holidays: Holiday[];
};

const childFoldFactsFor = ({
  caps,
  child,
  holidays,
  parent,
}: ChildFoldCtx): ChildFoldFacts => {
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

/** One (date, day count) evaluation of a parent's children. It holds the
 *  joint capacity the children serve when the booking lands there, and each
 *  child's own ceiling on it. The add-on gate reads both, so a child's
 *  label pairs its own fold check with the same date's allocation. */
export type ParentPairEvaluation = {
  combined: number;
  ceilings: ReadonlyArray<{ childId: number; part: ChildCapacityPart }>;
};

/** The date-less remaining each date-less allocation reads: the dynamic
 *  remaining over the static caps. A group the date-less map omits reads
 *  its static cap — the pair check's substitute. */
const datelessRemainingFor = (caps: ChildCapacityInfo): Map<number, number> =>
  new Map([...caps.staticCapByGroupId, ...caps.remainingByGroupId]);

/** The facts one parent's pair evaluations read: the parent, its children,
 *  and the group and calendar context. */
type ParentFoldCtx = {
  parent: ListingWithCount;
  children: readonly ListingWithCount[];
  caps: ChildCapacityInfo;
  holidays: Holiday[];
};

/** Every (date, day count) pair the parent offers, with the allocation each
 *  serves. Children that fold on different dates never share a pair. Children
 *  that need different day counts never share a pair. A pair's ceilings
 *  therefore sum only where the children can fold together. */
export const evaluateParentPairs = ({
  caps,
  children,
  holidays,
  parent,
}: ParentFoldCtx): ParentPairEvaluation[] => {
  const dayCounts = parentOfferedDayCounts(parent);
  const parentDates = parentDatesOf(parent, holidays);
  const dates: (string | null)[] =
    parentDates === null ? [null] : [...parentDates];
  const facts = children.map((child) => ({
    childId: child.id,
    facts: childFoldFactsFor({ caps, child, holidays, parent }),
  }));
  const datelessRemaining = datelessRemainingFor(caps);
  return dates.flatMap((date) =>
    dayCounts.map((days) => {
      const ceilings = facts.map(({ childId, facts: fact }) => ({
        childId,
        part: {
          groupIds: fact.groupIds,
          ownMax: childOwnCeilingOnDate(
            parentDates,
            fact,
            holidays,
            [days],
            date,
          ),
        },
      }));
      return {
        ceilings,
        combined: combinedChildCapacityForParent(
          listingGroups.idsFor(caps.membership, parent.id),
          ceilings.map(({ part }) => part),
          datelessRemaining,
        ),
      };
    }),
  );
};

/** The parent tickets a parent's children can serve together: the best
 *  feasible date and day count win. Children that fold on different dates
 *  must not sum. A minimum of three cannot take two units from a Monday-only
 *  child and two from a Tuesday-only child, because no single date carries
 *  both. The same rule binds day counts: the form books one count. Children
 *  that need different counts must not sum. A non-daily parent has no date
 *  selector, so one date-less evaluation answers. */
export const combinedChildCapacity = ({
  caps,
  children,
  holidays,
  parent,
}: ParentFoldCtx): number =>
  Math.max(
    0,
    ...evaluateParentPairs({ caps, children, holidays, parent }).map(
      (evaluation) => evaluation.combined,
    ),
  );

/** Removes one reserved line's places from every capped pool the listing
 *  draws from. A pool the map omits carries no cap. */
const reserveLineInPools = (
  charged: Map<number, number>,
  groupIds: readonly number[],
): void => {
  for (const groupId of groupIds) {
    if (charged.has(groupId)) charged.set(groupId, charged.get(groupId)! - 1);
  }
};

/** Whether the parent's capped pools still hold the lines the rest of the
 *  booking owes once its paired parent line is reserved. */
const parentPoolsHoldRest = (
  charged: ReadonlyMap<number, number>,
  parentGroupIds: readonly number[],
  minimum: number,
): boolean => {
  for (const groupId of parentGroupIds) {
    const remaining = charged.get(groupId);
    if (remaining !== undefined && remaining < minimum - 1) return false;
  }
  return true;
};

/** Whether one offered pair still serves the rest of the minimum once this
 *  child's line and the parent line it folds under are reserved. The reserved
 *  lines leave their pools first. The solver only reads the pools its capped
 *  children share, so `parentPoolsHoldRest` bounds the parent's own pools. */
const restServesAfterReservation =
  (
    caps: ChildCapacityInfo,
    minimum: number,
    childId: number,
    childGroupIds: readonly number[],
    parentGroupIds: readonly number[],
  ) =>
  ({ ceilings }: ParentPairEvaluation): boolean => {
    const own = ceilings.find((c) => c.childId === childId);
    // A child the pair's evaluation omits folds on no offered pair, so it
    // cannot join a booking on the pair.
    if (own === undefined || own.part.ownMax < 1) return false;
    const charged = datelessRemainingFor(caps);
    reserveLineInPools(charged, [...childGroupIds, ...parentGroupIds]);
    if (!parentPoolsHoldRest(charged, parentGroupIds, minimum)) return false;
    return (
      combinedChildCapacityForParent(
        parentGroupIds,
        ceilings.map((c) =>
          c.childId === childId
            ? { groupIds: c.part.groupIds, ownMax: own.part.ownMax - 1 }
            : c.part,
        ),
        charged,
      ) >=
      minimum - 1
    );
  };

/** Whether this child can join a booking that reaches the parent's minimum.
 *  The check runs per offered (date, day count) pair. The pair qualifies when
 *  the child folds on it and the children still serve the minimum with one of
 *  the child's lines counted. The child's reserved line and the parent line
 *  it folds under both leave their pools before the search starts. The pair
 *  then answers for a booking that includes the child. A standard child folds
 *  on every offered pair, so one pair that serves the minimum is enough. */
export const childJoinsMinimumBooking = (
  parent: ListingWithCount,
  child: ListingWithCount,
  caps: ChildCapacityInfo,
  holidays: Holiday[],
  evaluations: readonly ParentPairEvaluation[],
): boolean => {
  const facts = childFoldFactsFor({ caps, child, holidays, parent });
  return evaluations.some(
    restServesAfterReservation(
      caps,
      parent.min_quantity,
      child.id,
      facts.groupIds,
      listingGroups.idsFor(caps.membership, parent.id),
    ),
  );
};
