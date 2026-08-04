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

/** Each member listing id → the FIRST package on the page that books it.
 * Overlapping bundles may share a listing; the sole production caller
 * (single-package root detection) only reads this when the page has exactly
 * one package, where first-wins is exact. */
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
): Set<number> => new Set(packages.flatMap((pkg) => [...pkg.memberListingIds]));

/** The member ids of packages that hide their listings — names buyer surfaces
 * must never show (only the package name is public). */
export const concealedMemberIds = (
  packages: readonly TreePackage[],
): Set<number> => packageMemberIds(packages.filter((pkg) => pkg.hideListings));

/** The member listings a page ALSO sells standalone: those the visitor added
 * by the listing's own slug (beside its package). Non-members always sell
 * standalone, so they are not listed here; on a package-less page the set is
 * empty and unused. A HIDDEN package's member never sells standalone — only
 * its package's name is public — whatever the URL claims. */
export const explicitStandaloneIds = (
  listings: readonly { id: number; slug: string }[],
  packages: readonly TreePackage[],
  slugs: readonly string[],
): Set<number> => {
  const memberIds = packageMemberIds(packages);
  const concealedIds = concealedMemberIds(packages);
  const slugSet = new Set(slugs);
  return new Set(
    listings
      .filter(
        (listing) =>
          memberIds.has(listing.id) &&
          !concealedIds.has(listing.id) &&
          slugSet.has(listing.slug),
      )
      .map((listing) => listing.id),
  );
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

/** Each parent listing id → its single package path, from the order's
 * top-level lines: set only when EVERY line of that listing books through the
 * same one package. A parent also sold standalone — or through two packages —
 * has no single path, so its folded children's rows stay unstamped (they
 * belong to the order, not to one identifiable bundle). */
export const soleParentPackageIds = (
  lines: readonly { listingId: number; packageGroupId?: number | undefined }[],
): Map<number, number> => {
  const byParent = new Map<number, number>();
  const mixed = new Set<number>();
  for (const line of lines) {
    if (mixed.has(line.listingId)) continue;
    const groupId = line.packageGroupId ?? 0;
    const seen = byParent.get(line.listingId);
    if (seen === undefined) {
      byParent.set(line.listingId, groupId);
    } else if (seen !== groupId) {
      byParent.delete(line.listingId);
      mixed.add(line.listingId);
    }
  }
  for (const [listingId, groupId] of byParent) {
    if (groupId === 0) byParent.delete(listingId);
  }
  return byParent;
};

/** Stamp each folded child row with its parent's package (when the parent
 * books through exactly one path — see {@link soleParentPackageIds}), so a
 * bundle's add-ons group under it on tickets and emails. Top-level rows keep
 * the package their own line carries. */
export const stampChildRowPackages = <
  T extends {
    parentListingId?: number | undefined;
    packageGroupId?: number | undefined;
  },
>(
  rows: readonly T[],
  soleParentPackage: ReadonlyMap<number, number>,
): T[] =>
  rows.map((row) => {
    if ((row.packageGroupId ?? 0) !== 0) return row;
    const parentId = row.parentListingId ?? 0;
    const groupId =
      parentId === 0 ? undefined : soleParentPackage.get(parentId);
    return groupId === undefined ? row : { ...row, packageGroupId: groupId };
  });
