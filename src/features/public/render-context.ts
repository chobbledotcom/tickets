/**
 * The booking page's render-only context: the reads only the rendered page
 * needs, so the submit, quote, and API flows never pay for them.
 */

import {
  getGroupRemainingByListingId,
  getSharedGroupCapacities,
} from "#db/attendees/capacity/groups.ts";
import { getSelectedAttributesForListings } from "#db/attributes.ts";
import { listingGroups } from "#db/groups/table.ts";
import { getActiveHolidays } from "#db/holidays.ts";
import { addTicketPageImageUrls } from "#db/image-urls.ts";
import { getImagesForItem } from "#db/images.ts";
import { settings } from "#db/settings.ts";
import { getIframeMode } from "#shared/request-context.ts";
import { allChildListings } from "./child-listings.ts";
import { childCapacityInfo } from "./discovery/combined-capacity.ts";
import { applyBookingPageParentSoldOut } from "./discovery.ts";
import { bookingNavKey, publicNavProps } from "./site-nav.ts";
import type { TicketCtx } from "./types.ts";

/** The render-only view of the context: a parent whose children are all
 * unavailable is projected to sold-out. The GET page shows the parent sold
 * out (no Book control) instead of a normal form that only fails at submit.
 * Bookability uses the combined parent+child group demand. The children's
 * group-remaining is fetched date-less, like discovery. The authoritative
 * date-specific check is the fold at submit. The submit/quote paths keep the
 * un-projected `ctx`, so the fold's authoritative child rejection still runs
 * with its clear error. */
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
    // the rest of the site. It is dropped in an embedded iframe and skipped
    // when the public site is off, so neither case builds a menu it does not
    // show. The header entity's chain highlights. A combo highlights nothing.
    getIframeMode() || !settings.features.site
      ? Promise.resolve(undefined)
      : publicNavProps(bookingNavKey(ctx.galleryTarget)),
    // The layout renders the site footer's markdown on the booking page, so
    // its references resolve like the page's other words. An embedded iframe
    // page shows no footer, so it runs no footer lookup.
    addTicketPageImageUrls({
      ...ctx,
      footer: getIframeMode() ? null : settings.siteFooter,
    }),
  ]);
  const caps = childCapacityInfo(childCaps, childOwnRemaining, membership);
  return {
    ...ctx,
    attributesByListing,
    galleryImages,
    // The PER-GROUP remaining drives the per-parent quantity clamp. The clamp
    // keys on the SPECIFIC group a parent and child share. A parent sharing
    // a capped group with its child offers only floor(sharedRemaining / 2)
    // orders. The render ctx carries it so `childCappedMax` sees it.
    // Submit/quote keep it unset.
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
