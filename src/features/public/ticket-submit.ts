/**
 * The booking-page framework: builds the render context and funnels every
 * booking scenario through one render, quote, and submit path.
 */

import type { TicketListing } from "#booking/model.ts";
import { applyFlash } from "#routes/csrf.ts";
import { notFoundResponse } from "#routes/response.ts";
import { getBaseUrl } from "#routes/url.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { parseIsoDateParam } from "#shared/dates.ts";
import { normalizeCode } from "#shared/price-modifier.ts";
import { parsePositiveInt } from "#shared/validation/number.ts";
import type {
  BookingPrefill,
  TicketPrefill,
} from "#templates/public/reservations/types.ts";
import type { Group, ListingWithCount } from "#types";
import { dropChildListings, withActiveListings } from "./page-listings.ts";
import { renderCtx } from "./render-context.ts";
import { ticketResponse } from "./ticket-form.ts";
import { buildTicketListingsWithGroupCapacity } from "./ticket-listings.ts";
import { getTicketContext } from "./ticket-payment.ts";
import { calculateTicket, submitTicket } from "./ticket-submit/submit.ts";
import {
  applyHiddenNoindex,
  type TicketContextProvider,
  type TicketCtx,
  type TicketSharedContext,
} from "./types.ts";

/**
 * Inputs to the booking-page framework: the listings to offer, a context
 * provider that derives the fields/dates/questions/terms from them, the slugs
 * that form the default `/ticket/<slugs>` action, and an optional per-listing
 * pre-fill. Shared by {@link handleTicket} and its callers so the booking
 * "request" has a single named shape across every scenario.
 */
export type BookingRequest = {
  request: Request;
  /** Slugs forming the default `/ticket/<slugs>` form action. */
  slugs: string[];
  listings: TicketListing[];
  getContext: TicketContextProvider;
  prefill?: TicketCtx["prefill"] | undefined;
  /** When "calculate", a POST returns a priced quote instead of completing the
   * booking. GET requests still render the page regardless. */
  mode?: "calculate" | undefined;
};

/** Build the rendering context: derive the booking context from the listings
 * and mint a fresh CSRF token. */
const buildTicketCtx = async ({
  request,
  slugs,
  listings,
  getContext,
  prefill,
}: BookingRequest): Promise<TicketCtx> => {
  const [sharedCtx] = await Promise.all([
    getContext(listings),
    signCsrfToken(),
  ]);
  return {
    baseUrl: getBaseUrl(request),
    listings,
    slugs,
    ...sharedCtx,
    prefill,
  };
};

/** Handle ticket GET/POST orchestrator: render on GET, quote when in calculate
 * mode, otherwise submit. */
export const handleTicket = async (args: BookingRequest): Promise<Response> => {
  const { request, mode } = args;
  const ctx = await buildTicketCtx(args);
  const response =
    request.method === "GET"
      ? ticketResponse(await renderCtx(ctx))(applyFlash(request).error)
      : mode === "calculate"
        ? await calculateTicket(request, ctx)
        : await submitTicket(request, ctx);
  return applyHiddenNoindex(response, ctx.pageHidden);
};

/**
 * Build a booking pre-fill from query params: per-listing quantities from
 * `?q_<id>=n` (the order page redirects into `/ticket/<slugs>?q_<id>=1…` to
 * land the visitor with their chosen items selected), the date selector
 * from `?date=YYYY-MM-DD` (the /listings date filter carries the searched
 * date into a daily listing's Book CTA, #51), and the promo-code box from
 * `?promo=<code>` (an operator's link lands the code pre-typed, #2367). A
 * package needs no count pre-fill — its selector already defaults to one
 * bundle.
 */
export const parseQuantityPrefill = (
  request: Request,
  listings: TicketListing[],
): BookingPrefill | undefined => {
  const params = new URL(request.url).searchParams;
  const map = new Map<number, TicketPrefill>();
  for (const { listing } of listings) {
    const qty = parsePositiveInt(params.get(`q_${listing.id}`) ?? "");
    if (qty !== null) {
      map.set(listing.id, { quantity: qty });
    }
  }
  const date = parseIsoDateParam(params.get("date"));
  const promo = normalizeCode(params.get("promo") ?? "");
  if (map.size === 0 && date === null && promo === "") return;
  return {
    listings: map,
    ...(date !== null ? { date } : {}),
    ...(promo !== "" ? { promo } : {}),
  };
};

/**
 * A booking-page handler keyed by the URL slugs. `mode` prices the selection as
 * a `/calculate` running-total quote instead of completing the booking. The
 * result type varies: the plain path always renders, the cart path may fall
 * through with `null`.
 */
export type BySlugsHandler<R> = (
  request: Request,
  slugs: string[],
  mode?: "calculate",
) => R;

/**
 * Handle a booking page by slugs (multi-listing). `mode` selects between
 * completing the booking (the default) and pricing it as a `/calculate`
 * running-total quote; both load the same active listings and share one
 * rendering/submission path.
 */
export const handleBySlugs: BySlugsHandler<Promise<Response>> = (
  request,
  slugs,
  mode,
) =>
  withActiveListings(slugs, (listings) =>
    handleTicket({
      getContext: getTicketContext,
      listings,
      mode,
      prefill: parseQuantityPrefill(request, listings),
      request,
      slugs,
    }),
  );

/**
 * The booking-page framework entrypoint. Every booking scenario funnels through
 * here — single listing, multi-listing, group, and the order page — so they
 * share one rendering and submission path.
 *
 * `overrides` win over whatever {@link getTicketContext} derives.
 */
export const renderTicketFlow =
  (
    request: Request,
    slugs: string[],
    options: {
      group?: Group;
      overrides?: Partial<TicketSharedContext>;
      prefill?: BookingPrefill;
      mode?: "calculate";
    } = {},
  ) =>
  async (listings: ListingWithCount[]): Promise<Response> => {
    // Indirect entry points (group/order pages, renewals) load their listings
    // from membership / a saved cart rather than explicit URL slugs, so a child
    // member would otherwise render as a standalone, selectable quantity row a
    // buyer could book alone — bypassing the slug guard, which only rejects
    // DIRECT child slugs. Drop children here so they never appear as standalone
    // rows; their parents stay and re-fold them via `childrenByParentId`.
    const withoutChildren = await dropChildListings(listings);
    // When dropping children leaves nothing, every member was a child — a booking
    // can never start from a child, so the page has nothing
    // standalone-bookable. Render 404 rather than a 200 empty booking page. Every
    // production
    // caller (group/order/renewal) already hands a non-empty set, so this fires
    // exactly for the all-children case.
    if (withoutChildren.length === 0) return notFoundResponse();
    const activeListings =
      await buildTicketListingsWithGroupCapacity(withoutChildren);
    return handleTicket({
      getContext: async (e) => ({
        ...(await getTicketContext(e, options.group)),
        ...options.overrides,
      }),
      listings: activeListings,
      mode: options.mode,
      // A caller-supplied pre-fill wins; otherwise read the query pre-fill so
      // e.g. the order cart's chosen date carries onto a package page.
      prefill: options.prefill ?? parseQuantityPrefill(request, activeListings),
      request,
      slugs,
    });
  };
