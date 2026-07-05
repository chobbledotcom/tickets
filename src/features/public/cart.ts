/**
 * Multi-item cart booking pages: `/ticket/<slug>+<slug>+…` where a slug may
 * name a PACKAGE group as well as a listing (slugs are unique across both).
 * The order page's cart redirects here, so one booking can carry several
 * packages alongside ordinary listings.
 *
 * Slugs resolve in URL order. A slug that names neither an active listing nor
 * a complete package is dropped — exactly how unknown slugs have always been
 * dropped from multi-slug URLs — and so is any item that would book a listing
 * an EARLIER item already books: the same listing must never be reachable
 * through two paths in one order (a standalone row plus a package member, or
 * two overlapping packages), and first-wins matches the order the visitor
 * added things to their cart.
 */

import type { PagePackage } from "#shared/booking/page-packages.ts";
import { getListingsBySlugsBatch } from "#shared/db/listings.ts";
import type { Group, ListingWithCount } from "#shared/types.ts";
import { notFoundResponse } from "#routes/response.ts";
import { dropHiddenPackageMembers } from "./discovery.ts";
import { loadCartPackageBySlug } from "./groups.ts";
import {
  dropChildListings,
  getTicketContext,
  loadPagePackage,
} from "./ticket-payment.ts";
import { buildTicketListingsWithGroupCapacity } from "./ticket-listings.ts";
import { handleTicket, parseQuantityPrefill } from "./ticket-submit.ts";

/** One resolved cart item: a standalone listing or a whole package. */
type CartItem =
  | { kind: "listing"; listing: ListingWithCount }
  | { kind: "package"; group: Group; members: ListingWithCount[] };

/** Resolve a cart's slugs to items, or null when no slug names a package (the
 * plain multi-listing path owns that case, with its stricter 404 rules). */
const resolveCartSlugs = async (
  slugs: string[],
): Promise<CartItem[] | null> => {
  const listings = await getListingsBySlugsBatch(slugs);
  const items: CartItem[] = [];
  const bookedListingIds = new Set<number>();
  let anyPackage = false;
  for (const [index, slug] of slugs.entries()) {
    const listing = listings[index] ?? null;
    if (listing !== null) {
      if (!listing.active || bookedListingIds.has(listing.id)) continue;
      bookedListingIds.add(listing.id);
      items.push({ kind: "listing", listing });
      continue;
    }
    const pkg = await loadCartPackageBySlug(slug);
    if (pkg === null) continue;
    // A package that books a listing an earlier item already books is dropped
    // whole — a bundle never sells partially.
    if (pkg.listings.some((member) => bookedListingIds.has(member.id))) {
      continue;
    }
    for (const member of pkg.listings) bookedListingIds.add(member.id);
    items.push({ group: pkg.group, kind: "package", members: pkg.listings });
    anyPackage = true;
  }
  return anyPackage ? items : null;
};

/** The cart's listings in item order — packages expanded to their members —
 * with a hidden package's members dropped from the STANDALONE items (they only
 * sell through their package; an unknown-slug-style drop, not a 404, so the
 * rest of the cart still books). */
const cartListings = async (
  items: CartItem[],
): Promise<ListingWithCount[]> => {
  const standalone = await dropHiddenPackageMembers(
    items.flatMap((item) => (item.kind === "listing" ? [item.listing] : [])),
  );
  const standaloneIds = new Set(standalone.map((listing) => listing.id));
  return items.flatMap((item) =>
    item.kind === "listing"
      ? standaloneIds.has(item.listing.id)
        ? [item.listing]
        : []
      : item.members,
  );
};

/**
 * Handle a multi-slug booking page whose slugs include at least one package,
 * or return null so the caller falls through to the plain multi-listing path.
 * Children never render standalone rows (their parents re-fold them), matching
 * the group and order entry points; each package's `PagePackage` carries the
 * members that survived that drop, so a child member still books through its
 * parent's fold rather than a top-level row.
 */
export const handleCartBySlugs = async (
  request: Request,
  slugs: string[],
  mode?: "calculate",
): Promise<Response | null> => {
  const items = await resolveCartSlugs(slugs);
  if (items === null) return null;
  const withoutChildren = await dropChildListings(await cartListings(items));
  if (withoutChildren.length === 0) return notFoundResponse();
  const survivingIds = new Set(withoutChildren.map((listing) => listing.id));
  const activeListings =
    await buildTicketListingsWithGroupCapacity(withoutChildren);
  const packages: PagePackage[] = [];
  for (const item of items) {
    if (item.kind !== "package") continue;
    packages.push(
      await loadPagePackage(
        item.group,
        item.members
          .map((member) => member.id)
          .filter((id) => survivingIds.has(id)),
      ),
    );
  }
  return handleTicket({
    getContext: (listings) => getTicketContext(listings, undefined, packages),
    listings: activeListings,
    mode,
    prefill: parseQuantityPrefill(request, activeListings),
    request,
    slugs,
  });
};
