import type { PackageDisplay } from "#db/groups.ts";

/** Whether a SIGNED order's member names must be concealed, read fail-safe from
 * its persisted package group ids against displays the caller already holds.
 * Hidden when ANY booked package hides its listings.
 *
 * A group that no longer resolves also reads as hidden. A delete or an
 * un-package mid-checkout destroys the evidence of which kind it was, and the
 * refund path must not name its members. An order with no packages conceals
 * nothing. */
export const namesConcealedIn = (
  displays: ReadonlyMap<number, PackageDisplay>,
  packageGroupIds: Iterable<number>,
): boolean =>
  [...packageGroupIds].some(
    (groupId) => displays.get(groupId)?.hideListings ?? true,
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

/** Replace each concealed package line's buyer-facing name with its package's
 * name. Standalone and visible-package lines keep the listing name. Prices,
 * quantities and listing ids are untouched. */
export const concealLineNames = <
  T extends {
    name: string;
    listingId: number;
    packageGroupId?: number | undefined;
  },
>(
  items: T[],
  standIns: PackageStandIns,
): T[] =>
  standIns.byGroupId.size === 0
    ? items
    : items.map((item) => {
        const standIn =
          item.packageGroupId === undefined
            ? undefined
            : standIns.byGroupId.get(item.packageGroupId);
        return standIn === undefined ? item : { ...item, name: standIn };
      });
