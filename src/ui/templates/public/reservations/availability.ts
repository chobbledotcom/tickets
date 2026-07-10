/** Page-level availability and tree-shaping: the unavailability message, the
 * booking tree plus which listings get their own standalone row, the overall
 * sold-out check, and the lone header listing whose details head the page. */

/* jscpd:ignore-start */
import { t } from "#i18n";
import {
  type BuildTreeInput,
  buildBookingTree,
} from "#shared/booking/build-tree.ts";
import type { TicketListing } from "#shared/booking/model.ts";
import {
  type PackageLimitInfo,
  pageBundleLimits,
} from "#shared/booking/package-cap.ts";
import type { PagePackage } from "#shared/booking/page-packages.ts";
import type { BookingNode, BookingTree } from "#shared/booking/tree.ts";
import { standaloneListingIds } from "#shared/booking/tree.ts";
import { isReadOnly } from "#shared/env.ts";
import type { ListingWithCount } from "#shared/types.ts";
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
  const nodeByListingId = new Map<number, BookingNode>();
  for (const node of tree.nodes) {
    if (
      !nodeByListingId.has(node.listingId) ||
      node.quantityRule.kind === "BUYER_CHOICE"
    ) {
      nodeByListingId.set(node.listingId, node);
    }
  }
  return {
    nodeByListingId,
    singlePackagePage: packageCount === 1 && standaloneRowIds.size === 0,
    standaloneRowIds,
    tree,
  };
};
