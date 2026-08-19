/** Page-level availability and tree-shaping: the unavailability message, the
 * booking tree plus which listings get their own standalone row, the overall
 * sold-out check, and the lone header listing whose details head the page. */

import { type BuildTreeInput, buildBookingTree } from "#booking/build-tree.ts";
import type { TicketListing } from "#booking/model.ts";
import {
  type PackageLimitInfo,
  pageBundleLimits,
} from "#booking/package-cap.ts";
import type { PagePackage } from "#booking/page-packages.ts";
import {
  type BookingNode,
  type BookingTree,
  standaloneListingIds,
} from "#booking/tree.ts";
/* jscpd:ignore-start */
import { reduce } from "#fp";
import { t } from "#i18n";
import { isReadOnly } from "#shared/env.ts";
import type { ListingWithCount } from "#types";
/* jscpd:ignore-end */

/** Unavailability message shown when all listings are sold out or closed */
export const unavailableMessage = (
  allClosed: boolean,
  isSingleListing: boolean,
): string => {
  if (isReadOnly() || allClosed) return t("public.ticket.registration_closed");
  return isSingleListing
    ? t("public.ticket.listing_full")
    : t("public.multi.all_sold_out");
};

/** Each page package's bundle limit, plus whether the whole page should show as
 * sold out (nothing standalone left AND no package bookable). */
export const packagePageAvailability = (
  packages: PagePackage[],
  tree: BookingTree,
  listings: TicketListing[],
  standaloneRowIds: ReadonlySet<number>,
  page: PackageLimitInfo,
): { packageLimits: Map<number, number>; soldOut: boolean } => {
  const packageLimits = pageBundleLimits(tree, packages, page);
  const standaloneUnavailable = listings
    .filter((info) => standaloneRowIds.has(info.listing.id))
    .every((e) => e.isSoldOut || e.isClosed);
  const packagesUnavailable = [...packageLimits.values()].every(
    (limit) => limit === 0,
  );
  return {
    packageLimits,
    // Sold out only when every standalone row AND every bundle is dead (a
    // bundle with an unavailable member already reads limit 0; a package-less
    // page has no bundles, leaving just its listings' own availability).
    soldOut: standaloneUnavailable && packagesUnavailable,
  };
};

/** The lone listing whose rich details (image/date/location) head the page and
 * feed its OpenGraph tags, or null for a multi-listing page OR a hidden package
 * — a hidden package with one active member must not expose that member here. */
export const headerListing = (
  listings: TicketListing[],
  packages: PagePackage[],
): ListingWithCount | null =>
  listings.length === 1 && !packages.some((pkg) => pkg.hideListings)
    ? listings[0]!.listing
    : null;

/** Build the page's booking tree and the row-shaping facts read off it: which
 * listings get their own quantity row (those with a standalone BUYER_CHOICE
 * node), which node each row reads its field names from (a dual-path listing
 * resolves to its standalone node, not its member node), and whether the page
 * IS one package (every listing a member, nothing sold beside it — the classic
 * package-page layout). */
export const buildPageTree = (
  input: BuildTreeInput,
  packageCount: number,
): {
  tree: BookingTree;
  standaloneRowIds: Set<number>;
  nodeByListingId: Map<number, BookingNode>;
  singlePackagePage: boolean;
} => {
  const tree = buildBookingTree(input);
  const standaloneRowIds = standaloneListingIds(tree);
  // A BUYER_CHOICE node wins over any earlier node for the same listing id
  // (a dual-path listing resolves to its standalone node, not its member node);
  // every other kind keeps the first node seen.
  const nodeByListingId = reduce((acc, node: BookingNode) => {
    if (!acc.has(node.listingId) || node.quantityRule.kind === "BUYER_CHOICE") {
      acc.set(node.listingId, node);
    }
    return acc;
  }, new Map<number, BookingNode>())([...tree.nodes]);
  return {
    nodeByListingId,
    singlePackagePage: packageCount === 1 && standaloneRowIds.size === 0,
    standaloneRowIds,
    tree,
  };
};
