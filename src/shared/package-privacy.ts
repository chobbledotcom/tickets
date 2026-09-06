import type { PackageDisplay } from "#db/groups.ts";

/** Group 0 is a standalone path. An unresolved package cannot reveal names. */
export const hasNamedBookingPath = (
  displays: ReadonlyMap<number, Pick<PackageDisplay, "hideListings">>,
  bookingGroupIds: readonly number[],
): boolean =>
  bookingGroupIds.some(
    (groupId) => groupId === 0 || displays.get(groupId)?.hideListings === false,
  );

/** Stand-in names for pages that sell several packages. */
export type PackageStandIns = {
  /** Package name by group id for lines booked through that package. */
  byGroupId: ReadonlyMap<number, string>;
  /** Package name by member id for package-page errors and conflict text. */
  byListingId: ReadonlyMap<number, string>;
};

/** The package facts the stand-in builders read. */
type StandInPackage = {
  groupId: number;
  name: string;
  hideListings: boolean;
  memberListingIds: readonly number[];
};

/** Build the page's stand-ins: every hidden package's name keyed by its group
 * id, plus each of its members and those members' required children by listing
 * id (a child booked as part of a hidden bundle must not be named either). */
export const packageStandIns = (
  packages: readonly StandInPackage[],
  childIdsOfMember: (memberListingId: number) => readonly number[],
): PackageStandIns => {
  const byGroupId = new Map<number, string>();
  const byListingId = new Map<number, string>();
  for (const pkg of packages) {
    if (!pkg.hideListings) continue;
    byGroupId.set(pkg.groupId, pkg.name);
    for (const memberId of pkg.memberListingIds) {
      byListingId.set(memberId, pkg.name);
      for (const childId of childIdsOfMember(memberId)) {
        byListingId.set(childId, pkg.name);
      }
    }
  }
  return { byGroupId, byListingId };
};

/** Build stand-ins from the package facts already loaded for a booking page. */
export const ctxStandInNames = (ctx: {
  packages: readonly StandInPackage[];
  childrenByParentId: ReadonlyMap<
    number,
    readonly { listing: { id: number } }[]
  >;
}): PackageStandIns =>
  packageStandIns(ctx.packages, (memberId) =>
    (ctx.childrenByParentId.get(memberId) ?? []).map(
      (child) => child.listing.id,
    ),
  );

export type StandInName = (
  listingId: number,
  parentIds?: readonly [number, ...number[]],
) => string | undefined;

/** A named selection reveals its own name and the names of its selected children. */
export const standInNameFor =
  (
    standIns: PackageStandIns,
    namedListingIds: ReadonlySet<number>,
  ): StandInName =>
  (listingId, parentIds = [listingId]) =>
    namedListingIds.has(listingId) ||
    parentIds.some((parentId) => namedListingIds.has(parentId))
      ? undefined
      : (standIns.byListingId.get(parentIds[0]) ??
        standIns.byListingId.get(listingId));

/** Tagged package lines stay concealed even beside a named standalone selection. */
export const concealLineNames = <
  T extends {
    name: string;
    listingId: number;
    packageGroupId?: number | undefined;
  },
>(
  items: T[],
  standIns: PackageStandIns,
  namedListingIds: ReadonlySet<number>,
): T[] => {
  if (standIns.byGroupId.size === 0) return items;
  const nameFor = standInNameFor(standIns, namedListingIds);
  return items.map((item) => {
    const standIn =
      item.packageGroupId === undefined
        ? nameFor(item.listingId)
        : standIns.byGroupId.get(item.packageGroupId);
    return standIn === undefined ? item : { ...item, name: standIn };
  });
};
