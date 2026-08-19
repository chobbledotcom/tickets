/**
 * Multi-item cart booking pages: `/ticket/<slug>+<slug>+…` where a slug may
 * name a PACKAGE group as well as a listing (slugs are unique across both).
 * The order page's cart redirects here, so one booking can carry several
 * packages alongside ordinary listings.
 *
 * Slugs resolve in URL order. A slug that names neither an active listing nor
 * a complete package is dropped — exactly how unknown slugs have always been
 * dropped from multi-slug URLs — and so is an exact repeat of an item already
 * in the cart. OVERLAP is allowed: two packages sharing a listing, or a
 * package plus that listing's own row, book together in one order (each path
 * its own line and row), capacity permitting — the cart never restricts what
 * can be booked beyond stock.
 */

import { getListingsBySlugs } from "#db/listings/records.ts";
import { unique, uniqueBy } from "#fp";
import { notFoundResponse } from "#routes/response.ts";
import type { Group, ListingWithCount } from "#types";
import { dropHiddenPackageMembers } from "./discovery.ts";
import { type GroupWithListings, loadCartPackagesBySlugs } from "./groups.ts";
import { buildTicketListingsWithGroupCapacity } from "./ticket-listings.ts";
import {
  dropChildListings,
  getTicketContext,
  loadPagePackages,
} from "./ticket-payment.ts";
import {
  type BySlugsHandler,
  handleTicket,
  parseQuantityPrefill,
} from "./ticket-submit.ts";

/** One resolved cart item: a standalone listing or a whole package. */
type CartItem =
  | { kind: "listing"; listing: ListingWithCount }
  | { kind: "package"; group: Group; members: ListingWithCount[] };

/** The complete package behind each slug that names no listing, keyed by slug.
 * Slugs are unique across listings and packages, so only the leftovers can name
 * a package — and they all resolve in one batch rather than a lookup per slug. */
const cartPackagesBySlug = async (
  slugs: string[],
  listings: (ListingWithCount | null)[],
): Promise<Map<string, GroupWithListings>> => {
  const packageSlugs = unique(
    slugs.filter((_, index) => (listings[index] ?? null) === null),
  );
  const packages = await loadCartPackagesBySlugs(packageSlugs);
  return new Map(
    packages.flatMap((pkg, index) =>
      pkg === null ? [] : [[packageSlugs[index]!, pkg] as const],
    ),
  );
};

/** Resolve a cart's slugs to items, or null when no slug names a package (the
 * plain multi-listing path owns that case, with its stricter 404 rules). */
const resolveCartSlugs = async (
  slugs: string[],
): Promise<CartItem[] | null> => {
  const listings = await getListingsBySlugs(slugs);
  const packagesBySlug = await cartPackagesBySlug(slugs, listings);
  const items: CartItem[] = [];
  const standaloneIds = new Set<number>();
  const packageGroupIds = new Set<number>();
  let anyPackage = false;
  for (const [index, slug] of slugs.entries()) {
    const listing = listings[index] ?? null;
    if (listing !== null) {
      // Drop only an exact repeat of the same standalone listing; a listing
      // that also arrives inside a package keeps both paths.
      if (!listing.active || standaloneIds.has(listing.id)) continue;
      standaloneIds.add(listing.id);
      items.push({ kind: "listing", listing });
      continue;
    }
    const pkg = packagesBySlug.get(slug);
    if (pkg === undefined || packageGroupIds.has(pkg.group.id)) continue;
    packageGroupIds.add(pkg.group.id);
    items.push({ group: pkg.group, kind: "package", members: pkg.listings });
    anyPackage = true;
  }
  return anyPackage ? items : null;
};

/** The cart's listings in item order — packages expanded to their members,
 * each listing kept ONCE (a listing reachable through several items keeps all
 * its paths via `packages` + the standalone slugs, not repeated rows) — with a
 * hidden package's members dropped from the STANDALONE items (they only sell
 * through their package; an unknown-slug-style drop, not a 404, so the rest of
 * the cart still books). */
const cartListings = async (items: CartItem[]): Promise<ListingWithCount[]> => {
  const standalone = await dropHiddenPackageMembers(
    items.flatMap((item) => (item.kind === "listing" ? [item.listing] : [])),
  );
  const standaloneIds = new Set(standalone.map((listing) => listing.id));
  return uniqueBy((listing: ListingWithCount) => listing.id)(
    items.flatMap((item) =>
      item.kind === "listing"
        ? standaloneIds.has(item.listing.id)
          ? [item.listing]
          : []
        : item.members,
    ),
  );
};

/**
 * Handle a multi-slug booking page whose slugs include at least one package,
 * or return null so the caller falls through to the plain multi-listing path.
 * A child listing reached through a package's member expansion never renders
 * a standalone row (its parent re-folds it), and a non-standalone child slug
 * is dropped like any other unbookable slug — but a `bookable_alone` child
 * the visitor added BY ITS OWN SLUG keeps its standalone row beside the
 * parent's fold, exactly as the plain multi-listing page treats it. Each
 * package's `PagePackage` carries the members that survived the drop, so a
 * child member still books through its parent's fold rather than a top-level
 * row.
 */
export const handleCartBySlugs: BySlugsHandler<
  Promise<Response | null>
> = async (request, slugs, mode) => {
  const items = await resolveCartSlugs(slugs);
  if (items === null) return null;
  const soloChildIds = new Set(
    items.flatMap((item) =>
      item.kind === "listing" && item.listing.bookable_alone
        ? [item.listing.id]
        : [],
    ),
  );
  const listings = await cartListings(items);
  const dropped = new Set(
    (await dropChildListings(listings)).map((listing) => listing.id),
  );
  const withoutChildren = listings.filter(
    (listing) => dropped.has(listing.id) || soloChildIds.has(listing.id),
  );
  if (withoutChildren.length === 0) return notFoundResponse();
  const survivingIds = new Set(withoutChildren.map((listing) => listing.id));
  const activeListings =
    await buildTicketListingsWithGroupCapacity(withoutChildren);
  const packages = await loadPagePackages(
    items.flatMap((item) =>
      item.kind === "package"
        ? [
            {
              group: item.group,
              memberListingIds: item.members
                .map((member) => member.id)
                .filter((id) => survivingIds.has(id)),
            },
          ]
        : [],
    ),
  );
  return handleTicket({
    getContext: (listings) => getTicketContext(listings, undefined, packages),
    listings: activeListings,
    mode,
    prefill: parseQuantityPrefill(request, activeListings),
    request,
    slugs,
  });
};
