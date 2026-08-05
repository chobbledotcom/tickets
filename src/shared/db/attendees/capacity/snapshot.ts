/**
 * One capacity reading that answers every span on a page.
 *
 * A shorter stay's days are the first days of a longer one's, so a reading that
 * covers the widest span in play answers every narrower span too — in memory,
 * with no further reads. A page offering nine booking lengths therefore costs
 * what one length costs, which is what keeps it inside the edge request's
 * subrequest budget.
 */

import { requiredMapValue } from "#fp";
import { countsPerDate } from "#shared/capacity-rules.ts";
import { inPlaceholders, queryAll } from "#shared/db/client.ts";
import { listingGroups } from "#shared/db/groups.ts";
import { clampDurationDays } from "#shared/types.ts";
import {
  getGroupPerDayRemaining,
  getGroupRemainingByGroupId,
} from "./groups.ts";
import { getListingGroupMembership } from "./listing.ts";
import {
  daySpan,
  expandDailyRange,
  type IntervalRow,
  perDayLoads,
} from "./range.ts";
import type { ListingCapacityRow } from "./types.ts";

/** Booked units per day for each listing, in one query. */
const loadsByListing = async (
  listingIds: number[],
  days: string[],
): Promise<Map<number, Map<string, number>>> => {
  if (listingIds.length === 0) return new Map();
  const { startAt, endAt } = daySpan(days);
  const rows = await queryAll<IntervalRow & { listing_id: number }>(
    `SELECT attendee.listing_id, attendee.start_at, attendee.end_at, attendee.quantity
       FROM listing_attendees AS attendee
      WHERE attendee.listing_id IN (${inPlaceholders(
        listingIds,
      )}) AND attendee.start_at < ? AND attendee.end_at > ?`,
    [...listingIds, endAt, startAt],
  );
  const byListing = Map.groupBy(rows, (row) => row.listing_id);
  return new Map(
    listingIds.map((id) => [id, perDayLoads(byListing.get(id) ?? [], days)]),
  );
};

/**
 * Everything a span calculation reads, loaded once for the widest span in play.
 * `days` is empty when no date is chosen, which is what makes a reading
 * date-less: the day-by-day figures are then unused and the running totals
 * answer instead.
 */
export type CapacitySnapshot = {
  days: string[];
  membership: ReadonlyMap<number, number[]>;
  bookedByDay: ReadonlyMap<number, ReadonlyMap<string, number>>;
  groupByDay: ReadonlyMap<number, ReadonlyMap<string, number>>;
  datelessGroupRemaining: ReadonlyMap<number, number>;
};

/** Whether this listing is judged day by day in this snapshot. */
const judgedByDay = (
  listing: ListingCapacityRow,
  snapshot: Pick<CapacitySnapshot, "days">,
): boolean => countsPerDate(listing.listing_type) && snapshot.days.length > 0;

/**
 * Read capacity for `listings` once, covering every day the widest booking
 * span reaches from `date`. Pass `knownMembership` when the caller already
 * knows which groups the listings belong to, to save that lookup.
 */
export const loadCapacitySnapshot = async (
  listings: ListingCapacityRow[],
  date: string | null,
  widestSpanDays: number,
  knownMembership?: ReadonlyMap<number, number[]>,
): Promise<CapacitySnapshot> => {
  const days = date ? expandDailyRange(date, widestSpanDays) : [];
  const membership =
    knownMembership ?? (await getListingGroupMembership(listings));
  const groupsOf = (listing: ListingCapacityRow): number[] =>
    listingGroups.idsFor(membership, listing.id);
  const byDay = listings.filter((listing) => judgedByDay(listing, { days }));
  const byTotal = listings.filter((listing) => !judgedByDay(listing, { days }));

  const [datelessGroupRemaining, bookedByDay, groupByDay] = await Promise.all([
    getGroupRemainingByGroupId(byTotal.flatMap(groupsOf), null),
    loadsByListing(
      byDay.map((listing) => listing.id),
      days,
    ),
    // Every group, not just the day-judged listings' groups: a caller asking
    // what a whole group has left needs its day-by-day figures too.
    days.length === 0
      ? Promise.resolve(new Map<number, Map<string, number>>())
      : getGroupPerDayRemaining(listings.flatMap(groupsOf), days),
  ]);
  return { bookedByDay, datelessGroupRemaining, days, groupByDay, membership };
};

/** The snapshot's first `span` days. The span is clamped the same way a stored
 * booking's is, so a caller asking for no days at all still reads one — the day
 * the booking starts. */
const daysOfSpan = (
  snapshot: Pick<CapacitySnapshot, "days">,
  span: number,
): string[] => snapshot.days.slice(0, clampDurationDays(span));

/** The lowest of a set of day-by-day figures over the given days. */
const lowestOverDays = (
  byDay: ReadonlyMap<string, number>,
  days: string[],
): number =>
  Math.min(
    ...days.map((day) =>
      requiredMapValue(byDay, day, `No capacity read for ${day}`),
    ),
  );

/**
 * How many units each listing has left, each judged over its own booking span.
 * `spanOf` says how many days that listing occupies; a listing not judged day
 * by day reads its running total instead.
 */
export const remainingFromSnapshot = <Listing extends ListingCapacityRow>(
  snapshot: CapacitySnapshot,
  listings: Listing[],
  spanOf: (listing: Listing) => number,
): Map<number, number> => {
  const groupsOf = (listing: Listing): number[] =>
    listingGroups.idsFor(snapshot.membership, listing.id);
  return new Map(
    listings.map((listing: Listing): [number, number] => {
      const capsOf = (
        source: ReadonlyMap<number, ReadonlyMap<string, number>>,
        days: string[],
      ): number[] =>
        groupsOf(listing)
          .map((groupId) => source.get(groupId))
          .filter((byDay): byDay is ReadonlyMap<string, number> => !!byDay)
          .map((byDay) => lowestOverDays(byDay, days));
      if (!judgedByDay(listing, snapshot)) {
        const groupCaps = groupsOf(listing)
          .map((groupId) => snapshot.datelessGroupRemaining.get(groupId))
          .filter((remaining): remaining is number => remaining !== undefined);
        return [
          listing.id,
          Math.min(
            listing.max_attendees - listing.attendee_count,
            ...groupCaps,
          ),
        ];
      }
      const days = daysOfSpan(snapshot, spanOf(listing));
      const booked = requiredMapValue(
        snapshot.bookedByDay,
        listing.id,
        `Listing ${listing.id} was not in the capacity reading`,
      );
      const ownRemaining = Math.min(
        ...days.map(
          (day) =>
            listing.max_attendees -
            requiredMapValue(booked, day, `No booking total for ${day}`),
        ),
      );
      return [
        listing.id,
        Math.min(ownRemaining, ...capsOf(snapshot.groupByDay, days)),
      ];
    }),
  );
};

/**
 * How many units each capped group has left, each judged over the span given
 * for it — the widest any of its listings would occupy, since the cap has to
 * hold on every day any of them takes up.
 */
export const groupRemainingFromSnapshot = (
  snapshot: CapacitySnapshot,
  spanByGroupId: ReadonlyMap<number, number>,
): Map<number, number> => {
  if (snapshot.days.length === 0) {
    return new Map(snapshot.datelessGroupRemaining);
  }
  const remaining = new Map<number, number>();
  for (const [groupId, span] of spanByGroupId) {
    const byDay = snapshot.groupByDay.get(groupId);
    if (byDay) {
      remaining.set(groupId, lowestOverDays(byDay, daysOfSpan(snapshot, span)));
    }
  }
  return remaining;
};
