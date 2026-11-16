import {
  buildGroupCountSql,
  dateToRange,
  groupRunningTotal,
} from "#db/capacity.ts";
import { queryAll } from "#db/client.ts";
import { listingGroups } from "#db/groups/table.ts";
import { readRows } from "#db/read.ts";
import {
  among,
  type Counted,
  type Expr,
  equal,
  greaterThan,
  literal,
} from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import type { Node } from "#db/select/shape.ts";
import { tables } from "#db/select/tables.ts";
import { fieldById, mapById, requiredMapValue, unique } from "#fp";
import { capacityRuleTypeSql, countsPerDate } from "#shared/capacity-rules.ts";
import type { BatchLookup } from "#shared/request-cache.ts";
import type { ListingType } from "#types";
import { getListingGroupMembership, useListingById } from "./listing.ts";
import { perDayLoads, spanLoadsOf } from "./range.ts";
import type { ListingForGroupLookup, PerIdDayLoader } from "./types.ts";

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
  queryFor: BatchLookup<T>,
): Promise<Map<number, T>> => {
  const ids = uniquePositiveGroupIds(groupIds);
  return ids.length === 0 ? new Map() : queryFor(ids);
};

/** The groups among `ids` that carry a cap, each with its cap and the total
 *  that already counts against it. */
const cappedGroupTotals = (
  ids: readonly number[],
  total: (group: Node<"groups">) => Expr<Counted>,
) =>
  queryAll(
    from(tables.groups)
      .where((group) => [
        among(group.id, ids),
        greaterThan(group.max_attendees, literal(0)),
      ])
      .select((group) => ({
        id: group.id,
        max_attendees: group.max_attendees,
        total: total(group),
      })),
  );

type CappedGroupTotal = Awaited<ReturnType<typeof cappedGroupTotals>>[number];

/** Remaining capacity for each capped group. */
export const getGroupRemainingByGroupId: RemainingLookup<number> = (
  groupIds,
  date = null,
) =>
  cappedGroupQuery(groupIds, async (ids) => {
    const range = date ? dateToRange(date) : null;
    const dayRange = range && { end: range.endAt, start: range.startAt };
    const rows = await cappedGroupTotals(ids, (group) =>
      buildGroupCountSql(dayRange, null, group.id),
    );
    return mapById((row: CappedGroupTotal) =>
      Math.max(0, row.max_attendees - Number(row.total)),
    )(rows);
  });

/** Per-day remaining for several capped groups, loaded in two queries. */
export const getGroupPerDayRemaining: PerIdDayLoader<
  Map<string, number>
> = async (groupIds, days) => {
  const ids = uniquePositiveGroupIds(groupIds);
  if (ids.length === 0) return new Map();
  const caps = await cappedGroupTotals(ids, (group) =>
    groupRunningTotal(group.id, "dateLessCap"),
  );
  if (caps.length === 0) return new Map();
  const cappedIds = caps.map((cap) => cap.id);
  const rows = await queryAll(
    spanLoadsOf(
      from(tables.listing_attendees, { listing: {} })
        .as("attendee")
        .join("membership", tables.group_listings, (line) =>
          equal(line.membership.listing_id, line.listing_id),
        )
        .where((line) => [
          among(line.membership.group_id, cappedIds),
          capacityRuleTypeSql("perDateCap", line.listing.listing_type),
        ]),
      days,
      (line) => line.membership.group_id,
    ),
  );
  const rowsByGroup = Map.groupBy(rows, (row) => row.owner_id);
  return mapById(({ id, max_attendees, total }: CappedGroupTotal) => {
    const loads = perDayLoads(rowsByGroup.get(id) ?? [], days);
    return new Map(
      days.map((day) => [
        day,
        max_attendees -
          Number(total) -
          requiredMapValue(loads, day, `Day ${day} missing`),
      ]),
    );
  })(caps);
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
        .flatMap((member) => listingGroups.idsFor(membership, member.id)),
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
    const values = listingGroups
      .idsFor(membership, id)
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
    readRows(
      from(tables.groups)
        .where((group) => [
          among(group.id, ids),
          greaterThan(group.max_attendees, 0),
        ])
        .pick("id", "max_attendees"),
    ).then(fieldById("max_attendees")),
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
