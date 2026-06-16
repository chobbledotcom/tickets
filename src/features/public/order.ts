/**
 * Public order page.
 *
 * `GET /order` with no selection renders a gallery of every bookable listing as
 * a grid of selectable cards with a floating cart. Selection, the live count,
 * and showing/hiding the cart are pure CSS (`:checked` + a counter + `:has()`),
 * so the page needs no JavaScript.
 *
 * The cart is a GET form that submits back to `/order`; when the request carries
 * a selection (`?select_<id>=1…`) the handler 303-redirects to the canonical
 * multi-listing booking page `/ticket/<slugs>?q_<id>=1…`, which renders the
 * booking form pre-filled with the chosen items. So the order page is a thin
 * selector on top of the existing booking framework — there is no separate
 * booking renderer, and the booking lives at a real, re-rendable URL where a
 * validation error keeps the visitor's context instead of dropping it.
 */

import {
  htmlResponse,
  notFoundResponse,
  redirectResponse,
} from "#routes/response.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import { settings } from "#shared/db/settings.ts";
import { SELECT_PREFIX } from "#shared/order-select.ts";
import { loadSortedListings } from "#shared/sort-listings.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { orderGalleryPage } from "#templates/public.tsx";
import { buildTicketListingsWithGroupCapacity } from "./ticket-listings.ts";

/** Active, visible listings are the items offered on the order page. */
const isOrderListing = (e: ListingWithCount): boolean => e.active && !e.hidden;

/** Load the bookable listings for the order page, in the standard sorted order. */
const loadOrderListings = async (): Promise<ListingWithCount[]> =>
  (await loadSortedListings(isOrderListing)).listings;

/**
 * Guard: the order page is available only when the public site is on and the
 * owner has enabled it. Returns a Response to short-circuit, or null to proceed
 * — redirecting to admin login when the whole public site is off (as the other
 * public pages do) and 404ing when only the order page is disabled.
 */
const orderUnavailable = (): Response | null => {
  if (!settings.showPublicSite) return redirectResponse("/admin/login");
  if (!settings.orderEnabled) return notFoundResponse();
  return null;
};

/**
 * Build the booking-page URL for the selected items: every chosen item becomes
 * a slug (so sold-out picks still show on the booking page), and each item that
 * is actually available is pre-filled to quantity 1 via `?q_<id>=1` — this is
 * the "verify availability" step.
 */
const bookingUrlFor = async (selected: ListingWithCount[]): Promise<string> => {
  const ticketListings = await buildTicketListingsWithGroupCapacity(selected);
  const slugs = ticketListings.map((t) => t.listing.slug);
  const quantities = ticketListings
    .filter((t) => !t.isSoldOut && !t.isClosed && t.maxPurchasable >= 1)
    .map((t) => `q_${t.listing.id}=1`);
  const query = quantities.length > 0 ? `?${quantities.join("&")}` : "";
  return `/ticket/${slugs.join("+")}${query}`;
};

/**
 * GET /order — render the gallery, or (when the cart carried a selection)
 * redirect into the pre-filled multi-listing booking page.
 */
const handleOrder = async (request: Request): Promise<Response> => {
  const blocked = orderUnavailable();
  if (blocked) return blocked;

  const listings = await loadOrderListings();
  const params = new URL(request.url).searchParams;
  const selected = listings.filter(
    (e) => params.get(`${SELECT_PREFIX}${e.id}`) === "1",
  );
  if (selected.length > 0) {
    return redirectResponse(await bookingUrlFor(selected));
  }

  const ticketListings = await buildTicketListingsWithGroupCapacity(listings);
  return htmlResponse(
    orderGalleryPage(
      ticketListings,
      settings.websiteTitle,
      settings.orderIntroText || null,
    ),
  );
};

/** Route public order requests. */
export const routeOrder = createRouter(
  defineRoutes({ "GET /order": handleOrder }),
);
