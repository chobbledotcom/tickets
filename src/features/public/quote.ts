/**
 * Public quote pages.
 *
 * `GET /quote` renders a gallery of "purchase only" products. Selecting products
 * and submitting the floating cart POSTs back to `/quote`, which renders the
 * shared booking page (see {@link renderTicketFlow}/{@link handleTicket}) with
 * the chosen products pre-selected. That booking form then submits to
 * `/ticket/<slugs>` like any other multi-listing booking — the quote page is
 * simply the first new consumer of the booking-page framework.
 */

import { withCsrfForm } from "#routes/csrf.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirectResponse,
} from "#routes/response.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { settings } from "#shared/db/settings.ts";
import type { FormParams } from "#shared/form-data.ts";
import { loadSortedListings } from "#shared/sort-listings.ts";
import type { ListingWithCount } from "#shared/types.ts";
import {
  type BookingPrefill,
  quoteGalleryPage,
  type TicketListing,
} from "#templates/public.tsx";
import { buildTicketListingsWithGroupCapacity } from "./ticket-listings.ts";
import { getTicketContext } from "./ticket-payment.ts";
import { renderBookingPage } from "./ticket-submit.ts";

/** Header shown above the quote booking page. */
const QUOTE_HEADER = "Request a Quote";

/** Active, visible, purchase-only listings are the products offered for quoting. */
const isQuoteListing = (e: ListingWithCount): boolean =>
  e.active && !e.hidden && e.purchase_only;

/** Load the products offered on the quote page, in the standard sorted order. */
const loadQuoteListings = async (): Promise<ListingWithCount[]> =>
  (await loadSortedListings(isQuoteListing)).listings;

/**
 * Guard: the quote feature is available only when the public site is on and the
 * owner has enabled quotes. Returns a Response to short-circuit, or null to
 * proceed — redirecting to admin login when the whole public site is off (as
 * the other public pages do) and 404ing when only quotes are disabled.
 */
const quoteUnavailable = (): Response | null => {
  if (!settings.showPublicSite) return redirectResponse("/admin/login");
  if (!settings.quoteEnabled) return notFoundResponse();
  return null;
};

/** GET /quote — product gallery with the floating selection cart. */
const handleQuoteGallery = async (): Promise<Response> => {
  const blocked = quoteUnavailable();
  if (blocked) return blocked;

  const products = await loadQuoteListings();
  const [ticketListings] = await Promise.all([
    buildTicketListingsWithGroupCapacity(products),
    signCsrfToken(),
  ]);
  return htmlResponse(
    quoteGalleryPage(
      ticketListings,
      settings.websiteTitle,
      settings.quoteIntroText || null,
    ),
  );
};

/**
 * Build a prefill that pre-selects one of every available product. Sold-out,
 * closed, or zero-capacity products are skipped so the booking page never opens
 * with an unbookable quantity — this is the "verify availability" step.
 */
const buildQuotePrefill = (selected: TicketListing[]): BookingPrefill => {
  const listings = new Map<number, { quantity: number }>();
  for (const { listing, isSoldOut, isClosed, maxPurchasable } of selected) {
    if (isSoldOut || isClosed || maxPurchasable < 1) continue;
    listings.set(listing.id, { quantity: 1 });
  }
  return { listings };
};

/** POST /quote — render the booking page for the products the visitor ticked. */
const renderQuoteBooking = async (
  request: Request,
  form: FormParams,
): Promise<Response> => {
  const products = await loadQuoteListings();
  const selected = products.filter((p) => form.get(`select_${p.id}`) === "1");
  if (selected.length === 0) {
    return errorRedirect("/quote", "Please select at least one product");
  }

  const ticketListings = await buildTicketListingsWithGroupCapacity(selected);
  const slugs = selected.map((p) => p.slug);
  const actionUrl = `/ticket/${slugs.join("+")}`;
  // Render (don't submit) the shared booking page: the visitor fills in their
  // details and the form posts to `/ticket/<slugs>` like any other booking.
  return renderBookingPage({
    getContext: async (listings) => ({
      ...(await getTicketContext(listings)),
      actionUrl,
      groupName: QUOTE_HEADER,
    }),
    listings: ticketListings,
    prefill: buildQuotePrefill(ticketListings),
    request,
    slugs,
  });
};

/** POST /quote handler with CSRF protection. */
const handleQuoteSubmit = (request: Request): Promise<Response> => {
  const blocked = quoteUnavailable();
  if (blocked) return Promise.resolve(blocked);
  return withCsrfForm(
    request,
    (message) => errorRedirect("/quote", message),
    (form) => renderQuoteBooking(request, form),
  );
};

/** Route public quote requests. */
export const routeQuote = createRouter(
  defineRoutes({
    "GET /quote": handleQuoteGallery,
    "POST /quote": handleQuoteSubmit,
  }),
);
