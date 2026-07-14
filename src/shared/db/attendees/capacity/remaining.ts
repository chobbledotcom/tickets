/* jscpd:ignore-start */
import { filter } from "#fp";
import { countsPerDate } from "#shared/capacity-rules.ts";
import { inPlaceholders, queryAll } from "#shared/db/client.ts";
import {
  getGroupPerDayRemaining,
  getGroupRemainingByGroupId,
} from "./groups.ts";
import { getListingGroupMembership, useListingById } from "./listing.ts";
import {
  daySpan,
  expandDailyRange,
  type IntervalRow,
  perDayLoads,
} from "./range.ts";
import type { ListingCapacityRow, PerIdDayLoader } from "./types.ts";

/* jscpd:ignore-end */

/** Overlapping booking rows for several listings in one query. */
const overlappingRowsByListing: PerIdDayLoader<IntervalRow[]> = async (
  listingIds,
  days,
) => {
  if (listingIds.length === 0) return new Map();
  const { startAt, endAt } = daySpan(days);
  const rows = await queryAll<IntervalRow & { listing_id: number }>(
    `SELECT listing_id, start_at, end_at, quantity
       FROM listing_attendees
      WHERE listing_id IN (${inPlaceholders(
        listingIds,
      )}) AND start_at < ? AND end_at > ?`,
    [...listingIds, endAt, startAt],
  );
  return Map.groupBy(rows, (row) => row.listing_id);
};

/** Remaining bookable units for each listing over a date range. */
export function getListingRemainingForRange(
  listings: ListingCapacityRow[],
  date: string | null,
  durationDays?: number,
): Promise<Map<number, number>>;
export function getListingRemainingForRange(
  listingId: number,
  date: string | null,
  durationDays?: number,
): Promise<number | undefined>;
export async function getListingRemainingForRange(
  listingsOrId: ListingCapacityRow[] | number,
  date: string | null,
  durationDays = 1,
): Promise<Map<number, number> | number | undefined> {
  if (typeof listingsOrId === "number") {
    return useListingById(listingsOrId, undefined, async (listing) =>
      (await getListingRemainingForRange([listing], date, durationDays)).get(
        listingsOrId,
      ),
    );
  }
  const listings = listingsOrId;
  const usesRange = (listing: ListingCapacityRow): boolean =>
    countsPerDate(listing.listing_type) && date !== null;
  const daily = filter(usesRange)(listings);
  const totals = filter((listing: ListingCapacityRow) => !usesRange(listing))(
    listings,
  );
  const days = date ? expandDailyRange(date, durationDays) : [];
  const membership = await getListingGroupMembership(listings);
  const groupsOf = (listing: ListingCapacityRow): number[] =>
    membership.get(listing.id) ?? [];

  const [totalGroupRemaining, overlapByListing, dailyGroupPerDay] =
    await Promise.all([
      getGroupRemainingByGroupId(totals.flatMap(groupsOf), null),
      overlappingRowsByListing(
        daily.map((listing) => listing.id),
        days,
      ),
      getGroupPerDayRemaining(daily.flatMap(groupsOf), days),
    ]);

  const totalRemaining = totals.map((listing): [number, number] => {
    const base = listing.max_attendees - listing.attendee_count;
    const groupRemainings = groupsOf(listing)
      .map((groupId) => totalGroupRemaining.get(groupId))
      .filter((remaining): remaining is number => remaining !== undefined);
    return [listing.id, Math.min(base, ...groupRemainings)];
  });
  const dailyRemaining = daily.map((listing): [number, number] => {
    const loads = perDayLoads(overlapByListing.get(listing.id) ?? [], days);
    const listingRemaining = Math.min(
      ...days.map((day) => listing.max_attendees - loads.get(day)!),
    );
    const groupPerDayMins = groupsOf(listing)
      .map((groupId) => dailyGroupPerDay.get(groupId))
      .filter(
        (remaining): remaining is Map<string, number> =>
          remaining !== undefined,
      )
      .map((remaining) => Math.min(...days.map((day) => remaining.get(day)!)));
    return [listing.id, Math.min(listingRemaining, ...groupPerDayMins)];
  });
  return new Map([...totalRemaining, ...dailyRemaining]);
}
