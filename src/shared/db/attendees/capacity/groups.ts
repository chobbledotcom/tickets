/* jscpd:ignore-start */
import { mapBy, unique } from "#fp";
import { capacityRuleTypeSql, countsPerDate } from "#shared/capacity-rules.ts";
import { dateToRange } from "#shared/db/capacity.ts";
import { inPlaceholders, queryAll } from "#shared/db/client.ts";
import { columnMapByIds } from "#shared/db/query.ts";
import type { ListingType } from "#shared/types.ts";
import { getListingGroupMembership, useListingById } from "./listing.ts";
import {
  daySpan,
  expandDailyRange,
  type IntervalRow,
  perDayLoads,
} from "./range.ts";
import type { ListingForGroupLookup, PerIdDayLoader } from "./types.ts";

/* jscpd:ignore-end */

type RemainingMap = Map<number, number>;

type RemainingLookup<Input> = (
  inputs: Input[],
  date?: string | null,
) => Promise<RemainingMap>;

/** Distinct group ids worth a cap lookup. Zero means ungrouped. */
const uniquePositiveGroupIds = (groupIds: number[]): number[] =>
  unique(groupIds.filter((id) => id > 0));

/** Run a lookup over distinct capped-group candidates, skipping an empty query. */
const cappedGroupQuery = async <T>(
  groupIds: number[],
  queryFor: (ids: number[]) => Promise<Map<number, T>>,
): Promise<Map<number, T>> => {
  const ids = uniquePositiveGroupIds(groupIds);
  return ids.length === 0 ? new Map() : queryFor(ids);
};

/** Remaining capacity for each capped group. */
export const getGroupRemainingByGroupId: RemainingLookup<number> = (
  groupIds,
  date = null,
) =>
  cappedGroupQuery(groupIds, async (ids) => {
    const range = date ? dateToRange(date) : null;
    const datedCount = date
      ? `COALESCE((
        SELECT SUM(listing.booked_quantity)
          FROM listings AS listing
          JOIN group_listings AS groupListing ON groupListing.listing_id = listing.id
         WHERE groupListing.group_id = groupRow.id AND ${capacityRuleTypeSql(
           "dateLessCap",
           "listing.listing_type",
         )}
      ), 0) + COALESCE((
        SELECT SUM(attendee.quantity)
          FROM listing_attendees AS attendee
          JOIN listings AS listing ON listing.id = attendee.listing_id
          JOIN group_listings AS groupListing ON groupListing.listing_id = attendee.listing_id
         WHERE groupListing.group_id = groupRow.id
           AND ${capacityRuleTypeSql("perDateCap", "listing.listing_type")}
           AND attendee.start_at < ? AND attendee.end_at > ?
      ), 0)`
      : `COALESCE((
         SELECT SUM(listing.booked_quantity)
           FROM listings AS listing
           JOIN group_listings AS groupListing ON groupListing.listing_id = listing.id
          WHERE groupListing.group_id = groupRow.id
       ), 0)`;
    const countArgs = range ? [range.endAt, range.startAt] : [];
    const rows = await queryAll<{
      group_id: number;
      max_attendees: number;
      count: number;
    }>(
      `SELECT groupRow.id as group_id, groupRow.max_attendees,
            ${datedCount} as count
       FROM groups AS groupRow
      WHERE groupRow.id IN (${inPlaceholders(
        ids,
      )}) AND groupRow.max_attendees > 0
      GROUP BY groupRow.id`,
      [...countArgs, ...ids],
    );
    return mapBy("group_id", (row: (typeof rows)[number]) =>
      Math.max(0, row.max_attendees - row.count),
    )(rows);
  });

/** Per-day remaining for several capped groups, loaded in two queries. */
export const getGroupPerDayRemaining: PerIdDayLoader<
  Map<string, number>
> = async (groupIds, days) => {
  const ids = uniquePositiveGroupIds(groupIds);
  if (ids.length === 0) return new Map();
  const caps = await queryAll<{
    id: number;
    max_attendees: number;
    base: number;
  }>(
    `SELECT groupRow.id, groupRow.max_attendees,
            COALESCE((
              SELECT SUM(listing.booked_quantity)
                FROM listings AS listing
                JOIN group_listings AS groupListing ON groupListing.listing_id = listing.id
               WHERE groupListing.group_id = groupRow.id AND ${capacityRuleTypeSql(
                 "dateLessCap",
                 "listing.listing_type",
               )}
            ), 0) AS base
       FROM groups AS groupRow
      WHERE groupRow.id IN (${inPlaceholders(
        ids,
      )}) AND groupRow.max_attendees > 0`,
    ids,
  );
  if (caps.length === 0) return new Map();
  const cappedIds = caps.map((cap) => cap.id);
  const { startAt, endAt } = daySpan(days);
  type GroupRow = IntervalRow & { group_id: number };
  const rows = await queryAll<GroupRow>(
    `SELECT groupListing.group_id, attendee.start_at, attendee.end_at, attendee.quantity
       FROM listing_attendees AS attendee
       JOIN listings AS listing ON listing.id = attendee.listing_id
       JOIN group_listings AS groupListing ON groupListing.listing_id = attendee.listing_id
      WHERE groupListing.group_id IN (${inPlaceholders(cappedIds)})
        AND ${capacityRuleTypeSql("perDateCap", "listing.listing_type")}
        AND attendee.start_at < ? AND attendee.end_at > ?`,
    [...cappedIds, endAt, startAt],
  );
  const rowsByGroup = Map.groupBy(rows, (row) => row.group_id);
  return mapBy("id", ({ id, max_attendees, base }: (typeof caps)[number]) => {
    const loads = perDayLoads(rowsByGroup.get(id) ?? [], days);
    return new Map(
      days.map((day) => [day, max_attendees - base - loads.get(day)!]),
    );
  })(caps);
};

/** Tightest remaining group capacity over a whole daily span. */
export const getGroupRemainingForSpan = async (
  groupIds: number[],
  date: string | null,
  spanDays = 1,
): Promise<RemainingMap> => {
  if (date === null) return getGroupRemainingByGroupId(groupIds, null);
  const days = expandDailyRange(date, spanDays);
  const perDay = await getGroupPerDayRemaining(groupIds, days);
  return new Map(
    [...perDay].map(([groupId, byDay]) => [
      groupId,
      Math.min(...days.map((day) => byDay.get(day)!)),
    ]),
  );
};

/** Date-less remaining for capped groups reached from cumulative listings. */
export const getDatelessGroupRemaining = (
  members: readonly { id: number; listing_type: ListingType }[],
  membership: ReadonlyMap<number, number[]>,
): Promise<RemainingMap> =>
  getGroupRemainingByGroupId([
    ...new Set(
      members
        .filter((member) => !countsPerDate(member.listing_type))
        .flatMap((member) => membership.get(member.id) ?? []),
    ),
  ]);

/** Tightest capped-group value for each listing. */
export const remainingByListingOverGroups = (
  listingIds: readonly number[],
  membership: ReadonlyMap<number, number[]>,
  byGroup: ReadonlyMap<number, number>,
): RemainingMap => {
  const result: RemainingMap = new Map();
  for (const id of listingIds) {
    const values = (membership.get(id) ?? [])
      .map((groupId) => byGroup.get(groupId))
      .filter((value): value is number => value !== undefined);
    if (values.length > 0) result.set(id, Math.min(...values));
  }
  return result;
};

/** Load listing membership and the flat list of group ids. */
const loadMembershipWithGroupIds = async (
  listings: ListingForGroupLookup[],
): Promise<{ membership: Map<number, number[]>; groupIds: number[] }> => {
  const membership = await getListingGroupMembership(listings);
  return { groupIds: [...membership.values()].flat(), membership };
};

/** Tightest remaining capped-group capacity for each listing. */
export const getGroupRemainingByListingId: RemainingLookup<
  ListingForGroupLookup
> = async (listings, date = null) => {
  const candidates = date
    ? listings
    : listings.filter((listing) => !countsPerDate(listing.listing_type));
  const { membership, groupIds } = await loadMembershipWithGroupIds(candidates);
  const groupMap = await getGroupRemainingByGroupId(groupIds, date);
  return remainingByListingOverGroups(
    candidates.map((listing) => listing.id),
    membership,
    groupMap,
  );
};

/** Static maximum capacity for each capped group. */
export const getGroupStaticCapByGroupId = (
  groupIds: number[],
): Promise<RemainingMap> =>
  cappedGroupQuery(groupIds, (ids) =>
    columnMapByIds(
      "groups",
      "groupRow",
      "max_attendees",
      ids,
      " AND groupRow.max_attendees > 0",
    ),
  );

/** Group remaining, static caps, and membership for date-less package checks. */
export const getSharedGroupCapacities = async (
  listings: ListingForGroupLookup[],
): Promise<{
  remaining: RemainingMap;
  staticCap: RemainingMap;
  membership: Map<number, number[]>;
}> => {
  const { membership, groupIds } = await loadMembershipWithGroupIds(listings);
  const [remaining, staticCap] = await Promise.all([
    getDatelessGroupRemaining(listings, membership),
    getGroupStaticCapByGroupId(groupIds),
  ]);
  return { membership, remaining, staticCap };
};

/** Remaining group capacity for one listing, or undefined when no cap applies
 * or the listing does not exist. */
export const getGroupRemainingForListing = async (
  listingOrId: ListingForGroupLookup | number,
  date: string | null = null,
): Promise<number | undefined> => {
  const lookup = (listing: ListingForGroupLookup): Promise<RemainingMap> =>
    getGroupRemainingByListingId([listing], date);
  return typeof listingOrId === "number"
    ? useListingById(listingOrId, undefined, async (listing) =>
        (await lookup(listing)).get(listingOrId),
      )
    : (await lookup(listingOrId)).get(listingOrId.id);
};
