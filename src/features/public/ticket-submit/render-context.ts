/**
 * The GET booking page's render-only context: the loads the page shows, and
 * the sold-out projection only the page applies.
 */

import {
  getGroupRemainingByListingId,
  getSharedGroupCapacities,
} from "#db/attendees/capacity/groups.ts";
import { getSelectedAttributesForListings } from "#db/attributes.ts";
import { listingGroups } from "#db/groups/table.ts";
import { getActiveHolidays } from "#db/holidays.ts";
import {
  addFooterImageUrls,
  addTicketPageImageUrls,
  getImagesForItem,
} from "#db/images.ts";
import { settings } from "#db/settings.ts";
import { getIframeMode } from "#shared/request-context.ts";
import { allChildListings } from "../child-listings.ts";
import { childCapacityInfo } from "../discovery/combined-capacity.ts";
import { applyBookingPageParentSoldOut } from "../discovery.ts";
import { publicNavProps } from "../site-nav.ts";
import type { TicketCtx } from "../types.ts";

/** The render-only view of the context: a parent whose children are all
 * unavailable is projected to sold-out so the GET page shows it sold out (no
 * Book control) instead of a normal form that would only fail at submit.
 * Bookability uses the combined parent+child group demand,
 * so the children's group-remaining is fetched (date-less, like discovery — the
 * authoritative date-specific check is the fold at submit). The submit/quote
 * paths keep the un-projected `ctx` so the fold's authoritative child rejection
 * still runs with its clear error. */
export const renderCtx = async (ctx: TicketCtx): Promise<TicketCtx> => {
  const children = allChildListings(ctx.childrenByParentId);
  const [
    childCaps,
    childOwnRemaining,
    holidays,
    membership,
    galleryImages,
    attributesByListing,
    nav,
  ] = await Promise.all([
    getSharedGroupCapacities(children),
    getGroupRemainingByListingId(children),
    getActiveHolidays(),
    listingGroups.getIdsByKeys([
      ...ctx.listings.map((l) => l.listing.id),
      ...children.map((c) => c.id),
    ]),
    // The header entity's image gallery — read only here, on the render path,
    // never on the submit/quote/API flows that don't show it.
    ctx.galleryTarget
      ? getImagesForItem(ctx.galleryTarget.type, ctx.galleryTarget.id)
      : Promise.resolve([]),
    getSelectedAttributesForListings([
      ...ctx.listings.map((entry) => entry.listing.id),
      ...children.map((child) => child.id),
    ]),
    // The site menu shows above a normal booking page so a visitor can reach
    // the rest of the site. It is dropped in an embedded iframe, and skipped
    // when the public site is off (its Home/Listings links would only bounce a
    // visitor to the admin login), so neither case builds a menu it won't show.
    getIframeMode() || !settings.features.site
      ? Promise.resolve(undefined)
      : publicNavProps(null),
    // The layout renders the site footer's markdown on the booking page, so
    // its references resolve like the page's other words.
    addTicketPageImageUrls({ ...ctx, footer: settings.siteFooter }),
    addFooterImageUrls(),
  ]);
  const caps = childCapacityInfo(childCaps, childOwnRemaining, membership);
  return {
    ...ctx,
    attributesByListing,
    galleryImages,
    // The PER-GROUP remaining drives the per-parent quantity clamp keyed by the
    // SPECIFIC group a parent and child share: a parent sharing a capped
    // group with its child offers only floor(sharedRemaining / 2) orders. Carried
    // on the render ctx so `childCappedMax` sees it; submit/quote
    // keep it unset.
    groupIdsByListingId: membership,
    groupRemainingByGroupId: childCaps.remaining,
    listings: applyBookingPageParentSoldOut(
      ctx.listings,
      ctx.childrenByParentId,
      caps,
      holidays,
    ),
    ...(nav ? { nav } : {}),
  };
};
