import type { Group } from "#shared/types.ts";

/**
 * The **page package** — one package bundle offered on a booking page. A page
 * can sell any number of bundles alongside ordinary listings, so everything
 * that used to live as page-wide "the package" fields (one group id, one
 * quantity map, one hide flag) is instead carried per bundle in one of these.
 * A single-package page is simply a page whose `packages` array has one entry
 * ("a single item is an array of one").
 *
 * `TreePackage` is the structural core the pure tree builder needs; it can be
 * rebuilt from stored data with no group row in hand (the payment webhook does
 * this). `PagePackage` adds the display fields a rendered page needs.
 */

/** The structural facts of one package bundle: which listings it books, how
 * many of each per package, and its price overrides. */
export type TreePackage = {
  readonly groupId: number;
  /** Member listing ids, in display order. */
  readonly memberListingIds: readonly number[];
  /** How many of each member one package includes (every member, default 1). */
  readonly quantities: ReadonlyMap<number, number>;
  /** Flat per-member price overrides in minor units (only members that have
   * one — a positive price or an explicit free 0). */
  readonly prices: ReadonlyMap<number, number>;
  /** Each customisable member's per-day overrides (day count → minor units). */
  readonly dayPrices: ReadonlyMap<number, ReadonlyMap<number, number>>;
  /** Whether buyers see the member listings, or only the package name. */
  readonly hideListings: boolean;
};

/** One package bundle as a booking page carries it: the structural facts plus
 * the group's display fields. */
export type PagePackage = TreePackage & {
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly terms: string;
};

/** The pricing maps a package's membership rows resolve to (the shape
 * `loadPackageMemberPricing` returns). */
type MemberPricing = {
  prices: Map<number, number>;
  quantities: Map<number, number>;
  dayPrices: Map<number, Map<number, number>>;
};

/** Build one {@link PagePackage} from its group row, its page members (in
 * display order), and its loaded member pricing. */
export const buildPagePackage = (
  group: Group,
  memberListingIds: readonly number[],
  pricing: MemberPricing,
): PagePackage => ({
  dayPrices: pricing.dayPrices,
  description: group.description,
  groupId: group.id,
  hideListings: group.hide_package_listings,
  memberListingIds,
  name: group.name,
  prices: pricing.prices,
  quantities: pricing.quantities,
  slug: group.slug,
  terms: group.terms_and_conditions,
});

/** Each member listing id → the one package on the page that books it. Pages
 * never offer the same listing through two packages (the resolver rejects such
 * a cart), so the first package wins by construction. */
export const packageByMemberListingId = <T extends TreePackage>(
  packages: readonly T[],
): Map<number, T> => {
  const byMember = new Map<number, T>();
  for (const pkg of packages) {
    for (const listingId of pkg.memberListingIds) {
      if (!byMember.has(listingId)) byMember.set(listingId, pkg);
    }
  }
  return byMember;
};

/** The listing ids booked by any of the given packages. */
export const packageMemberIds = (
  packages: readonly TreePackage[],
): Set<number> =>
  new Set(packages.flatMap((pkg) => [...pkg.memberListingIds]));

/** Keeps only the listings no page package books — the rows that keep their
 * own quantity selector. */
export const withoutPackageMembers = <T>(
  listings: readonly T[],
  packages: readonly TreePackage[],
  idOf: (listing: T) => number,
): T[] => {
  const memberIds = packageMemberIds(packages);
  return listings.filter((listing) => !memberIds.has(idOf(listing)));
};

/** The terms a page with packages must show: each package's own terms (in page
 * order, without repeats), or the fallback when no package carries any. */
export const combinedPackageTerms = (
  packages: readonly PagePackage[],
  fallback: string,
): string => {
  const terms = [...new Set(packages.map((pkg) => pkg.terms))].filter(
    (text) => text.length > 0,
  );
  return terms.length > 0 ? terms.join("\n\n") : fallback;
};

/** One merged listing-id map across a page's packages (member sets are
 * disjoint on a page, so merging loses nothing). Curried on which per-package
 * map to merge. */
const mergedPackageMap =
  <V,>(pick: (pkg: TreePackage) => ReadonlyMap<number, V>) =>
  (packages: readonly TreePackage[]): Map<number, V> => {
    const merged = new Map<number, V>();
    for (const pkg of packages) {
      for (const [listingId, value] of pick(pkg)) {
        if (!merged.has(listingId)) merged.set(listingId, value);
      }
    }
    return merged;
  };

/** Every package's flat price overrides as one listing-id map. */
export const mergedPackagePrices = mergedPackageMap((pkg) => pkg.prices);

/** Every package's per-day overrides as one listing-id map. */
export const mergedPackageDayPrices = mergedPackageMap((pkg) => pkg.dayPrices);

/** Each member listing id → its package's group id, for the order's packages —
 * the map an order carries so booking rows and signed checkout lines record
 * which bundle each line was booked through. */
export const packageGroupIdByListingId = (
  packages: readonly TreePackage[],
): Map<number, number> =>
  new Map(
    [...packageByMemberListingId(packages)].map(([listingId, pkg]) => [
      listingId,
      pkg.groupId,
    ]),
  );

/** Stamp each booking row with the package it was booked through: its own
 * listing's package, else its parent's (a folded child books as part of its
 * parent's bundle). Rows outside every package stay unstamped. Returns the
 * rows unchanged when the order has no packages. */
export const stampBookingPackages = <
  T extends { listingId: number; parentListingId?: number | undefined },
>(
  bookings: readonly T[],
  groupIdByListingId: ReadonlyMap<number, number> | undefined,
): (T & { packageGroupId?: number })[] => {
  if (groupIdByListingId === undefined || groupIdByListingId.size === 0) {
    return [...bookings];
  }
  return bookings.map((booking) => {
    const groupId =
      groupIdByListingId.get(booking.listingId) ??
      (booking.parentListingId !== undefined
        ? groupIdByListingId.get(booking.parentListingId)
        : undefined);
    return groupId === undefined ? booking : { ...booking, packageGroupId: groupId };
  });
};
