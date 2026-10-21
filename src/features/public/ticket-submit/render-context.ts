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
import { addFooterImageUrls, addTicketPageImageUrls } from "#db/image-urls.ts";
import { getImagesForItem } from "#db/images.ts";
import { settings } from "#db/settings.ts";
import { allChildListings } from "#routes/public/child-listings.ts";
import { childCapacityInfo } from "#routes/public/discovery/combined-capacity.ts";
import { applyBookingPageParentSoldOut } from "#routes/public/discovery.ts";
import { publicNavProps } from "#routes/public/site-nav.ts";
import type { TicketCtx } from "#routes/public/types.ts";
import { getIframeMode } from "#shared/request-context.ts";

/** The render-only view of the context. It projects a parent whose children
 * are all unavailable to sold-out, so the GET page shows it sold out (no Book
 * control). Without the projection, the page renders a normal form that only
 * fails at submit. Bookability uses the combined parent+child group demand, so
 * the children's group-remaining is fetched date-less, like discovery. The
 * authoritative date-specific check is the fold at submit. The submit/quote
 * paths keep the un-projected `ctx`, so the fold's authoritative child
 * rejection still runs with its clear error. */
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
    // never on the submit/quote/API flows that do not show it.
    ctx.galleryTarget
      ? getImagesForItem(ctx.galleryTarget.type, ctx.galleryTarget.id)
      : Promise.resolve([]),
    getSelectedAttributesForListings([
      ...ctx.listings.map((entry) => entry.listing.id),
      ...children.map((child) => child.id),
    ]),
    // The site menu shows above a normal booking page so a visitor can reach
    // the rest of the site. It is dropped in an embedded iframe. It is also
    // skipped when the public site is off, because its Home/Listings links
    // only bounce a visitor to the admin login. Neither case builds a menu.
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
    // The PER-GROUP remaining drives the per-parent quantity clamp. The clamp
    // is keyed by the SPECIFIC group a parent and child share. A parent
    // sharing a capped group with its child offers only
    // floor(sharedRemaining / 2) orders. It lives on the render ctx, so
    // `childCappedMax` sees it. Submit/quote keep it unset.
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
