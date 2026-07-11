import {
  type BuildTreeInput,
  buildBookingTree,
} from "#shared/booking/build-tree.ts";
import type { TicketListing } from "#shared/booking/model.ts";
import {
  type PackageLimitInfo,
  pagePackageBundleLimit,
} from "#shared/booking/package-cap.ts";
import type { PagePackage } from "#shared/booking/page-packages.ts";
import {
  type BookingNode,
  type BookingTree,
  standaloneListingIds,
} from "#shared/booking/tree.ts";
import type { AddOnOption } from "#shared/db/modifier-resolve.ts";
import { isPaidListing, type ListingWithCount } from "#shared/types.ts";

/** Whether a listing is paid through ANY path this page sells it. Each package
 * that bundles it prices it by that package's own rule: a flat override
 * REPLACES the base price for that path (an explicit free 0 makes the path
 * free), a positive per-day override makes a customisable member paid, and
 * without either the listing's own pricing decides. A listing nobody bundles —
 * or one ALSO sold on its own row beside its bundles — charges its own price
 * on the standalone path, whatever any bundle says. One cheap path never hides
 * a charging one: the buyer can always choose the paid path, so the provider
 * fields must render. */
const paidInContext = (
  info: TicketListing,
  packages: readonly PagePackage[],
  standaloneRowIds: ReadonlySet<number>,
): boolean => {
  const id = info.listing.id;
  const owners = packages.filter((pkg) => pkg.memberListingIds.includes(id));
  const paidVia = (pkg: PagePackage): boolean => {
    const override = pkg.prices.get(id);
    if (override !== undefined) return override > 0;
    const dayOverrides = pkg.dayPrices.get(id);
    if (dayOverrides && [...dayOverrides.values()].some((p) => p > 0)) {
      return true;
    }
    return isPaidListing(info.listing);
  };
  const sellsStandalone = owners.length === 0 || standaloneRowIds.has(id);
  return (
    owners.some(paidVia) || (sellsStandalone && isPaidListing(info.listing))
  );
};

/** The non-listing inputs that decide whether a page charges: its add-ons, the
 * packages that bundle its listings, and which listings sell on a standalone row.
 * Shared by the page-paid and page-or-child-paid checks so both read one shape. */
export type PaidContext = {
  addOns: AddOnOption[] | undefined;
  packages: readonly PagePackage[];
  standaloneRowIds: ReadonlySet<number>;
};

/** Whether the page itself (its listings or add-ons, NOT possible children) is
 * paid — so its provider-imposed email renders required. */
export const pagePaid = (
  listings: TicketListing[],
  ctx: PaidContext,
): boolean =>
  listings.some((e) => paidInContext(e, ctx.packages, ctx.standaloneRowIds)) ||
  (ctx.addOns?.some((addOn) => addOn.requiresPayment) ?? false);

/** Whether the contact-field set must include a paid order's provider-imposed
 * fields: any page listing, possible child, or add-on is paid. A free parent with
 * a paid child still needs the email field present (non-required, enforced
 * server-side when the folded order is actually paid). */
export const pageOrChildPaid = (
  listings: TicketListing[],
  childrenByParentId: Map<number, TicketListing[]> | undefined,
  ctx: PaidContext,
): boolean => {
  const children = childrenByParentId
    ? [...childrenByParentId.values()].flat()
    : [];
  return (
    pagePaid(listings, ctx) || children.some((e) => isPaidListing(e.listing))
  );
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
  const packageLimits = new Map(
    packages.map((pkg) => [
      pkg.groupId,
      pagePackageBundleLimit(tree, pkg, page),
    ]),
  );
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
