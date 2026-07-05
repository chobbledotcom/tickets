/**
 * Booking-page framework shell: render a booking page on GET, price a quote in
 * calculate mode, or submit it. The parse/price/complete pipeline lives in
 * `ticket-process.ts` and the pricing in `ticket-pricing.ts`; this module owns
 * the request routing, the rendering context, and the CSRF/quote wrappers.
 */

import { applyFlash, withCsrfForm } from "#routes/csrf.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
} from "#routes/response.ts";
import { getBaseUrl } from "#routes/url.ts";
import type { TicketListing } from "#shared/booking/model.ts";
import { isPaymentsEnabled } from "#shared/config.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { formatCurrency } from "#shared/currency.ts";
import { parseIsoDateParam } from "#shared/dates.ts";
import {
  getGroupRemainingByListingId,
  getSharedGroupCapacities,
} from "#shared/db/attendees.ts";
import { getGroupIdsByListingIds } from "#shared/db/groups.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { ATTENDEE_DEMO_FIELDS, applyDemoOverrides } from "#shared/demo.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { Group, ListingWithCount } from "#shared/types.ts";
import { parsePositiveInt } from "#shared/validation/number.ts";
import {
  type BookingPrefill,
  orderSummary,
  orderSummaryMessage,
  type TicketPrefill,
} from "#templates/public.tsx";
import {
  applyBookingPageParentSoldOut,
  childCapacityInfo,
} from "./discovery.ts";
import { ticketResponse } from "./ticket-form.ts";
import { buildTicketListingsWithGroupCapacity } from "./ticket-listings.ts";
import {
  checkAvailability,
  dropChildListings,
  getTicketContext,
  withActiveListings,
} from "./ticket-payment.ts";
import {
  checkSoldOutTiers,
  TICKETS_UNAVAILABLE_MESSAGE,
} from "./ticket-pricing.ts";
import { prepareOrder, processSubmission } from "./ticket-process.ts";
import {
  applyHiddenNoindex,
  type TicketContextProvider,
  type TicketCtx,
  type TicketSharedContext,
} from "./types.ts";

const withTicketCsrfForm = (
  request: Request,
  onError: (message: string) => Response,
  onForm: (form: FormParams) => Promise<Response>,
): Promise<Response> => withCsrfForm(request, onError, onForm);

/** Handle POST for ticket registration */
const submitTicket = (request: Request, ctx: TicketCtx): Promise<Response> =>
  withTicketCsrfForm(
    request,
    // CSRF failures redirect with a flash (the token expired or was tampered
    // with — the page reloads with a fresh token). Field-level validation
    // errors instead re-render inline so the visitor keeps what they entered.
    (message) =>
      errorRedirect(ctx.actionUrl ?? `/ticket/${ctx.slugs.join("+")}`, message),
    (form) => {
      applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);
      return processSubmission(request, ctx, form);
    },
  );

/**
 * Build the running-total fragment for a parsed-and-priced quote, matching what
 * the submit path would actually collect:
 * - a sold-out answer tier is rejected (as submit would), run at zero visits
 *   since a quote strips the PII needed to look the buyer's count up;
 * - with no payment provider configured the booking is taken without charging,
 *   but a paid order still owes its full value (see the free path), so
 *   the quote surfaces that amount owed rather than implying the order is free.
 *
 * A returning buyer's `min_visits` modifiers are not reflected — that needs the
 * stripped contact details — so the quote is a zero-visits estimate; the submit
 * path reprices with the real count before charging.
 */
const renderQuote = async (
  ctx: TicketCtx,
  form: FormParams,
): Promise<Response> => {
  const prepared = await prepareOrder(ctx, form);
  if (!prepared.ok) return htmlResponse(orderSummaryMessage(prepared.error));
  const { pricingParams, pricedOrder } = prepared;
  const soldOut = await checkSoldOutTiers(pricingParams, 0);
  if (soldOut) return htmlResponse(orderSummaryMessage(soldOut));
  // Reject a cart that has exhausted capacity (e.g. a dated daily listing whose
  // capped group is full for the chosen day), as the booking submit would. The
  // folded ctx (page listings ∪ selected children) drives the check so a quote
  // reflects the children's capacity too.
  const available = await checkAvailability(
    pricingParams.ctx.listings,
    pricingParams.quantities,
    pricingParams.date,
    pricingParams.dayCount,
  );
  if (!available) {
    return htmlResponse(orderSummaryMessage(TICKETS_UNAVAILABLE_MESSAGE));
  }
  if (isPaymentsEnabled()) {
    return htmlResponse(
      orderSummary(pricedOrder, Boolean(pricingParams.reservationAmount)),
    );
  }
  // No payment provider: the booking is taken without charging, but a paid order
  // still records its full value as the amount owed (see processSubmission), so
  // surface that figure instead of implying the order is free. fullSubtotal is
  // the order value before any deposit split or booking fee — exactly what the
  // submit path stores as the remaining balance.
  return htmlResponse(
    pricedOrder.fullSubtotal > 0
      ? orderSummaryMessage(
          `No online payment is needed now — you'll owe ${formatCurrency(
            pricedOrder.fullSubtotal,
          )} for this booking.`,
        )
      : orderSummaryMessage("No payment required for this booking."),
  );
};

/**
 * Handle POST for the `/calculate` running total. Runs the same parse-and-price
 * path as a real submission but stops before contact validation or any database
 * write, returning the priced order as an HTML fragment. PII fields are never
 * read here — a quote prices the cart with an empty contact — so the client
 * strips them before sending and the server ignores any that arrive.
 */
const calculateTicket = (request: Request, ctx: TicketCtx): Promise<Response> =>
  withTicketCsrfForm(
    request,
    (message) => htmlResponse(orderSummaryMessage(message), 403),
    (form) => renderQuote(ctx, form),
  );

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

/** The render-only view of the context: a parent whose children are all
 * unavailable is projected to sold-out so the GET page shows it sold out (no
 * Book control) instead of a normal form that would only fail at submit.
 * Bookability uses the combined parent+child group demand,
 * so the children's group-remaining is fetched (date-less, like discovery — the
 * authoritative date-specific check is the fold at submit). The submit/quote
 * paths keep the un-projected `ctx` so the fold's authoritative child rejection
 * still runs with its clear error. */
const renderCtx = async (ctx: TicketCtx): Promise<TicketCtx> => {
  const children = [...ctx.childrenByParentId.values()]
    .flat()
    .map((child) => child.listing);
  const [childCaps, childOwnRemaining, holidays, membership] =
    await Promise.all([
      getSharedGroupCapacities(children),
      getGroupRemainingByListingId(children),
      getActiveHolidays(),
      getGroupIdsByListingIds([
        ...ctx.listings.map((l) => l.listing.id),
        ...children.map((c) => c.id),
      ]),
    ]);
  const caps = childCapacityInfo(childCaps, childOwnRemaining, membership);
  return {
    ...ctx,
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
  };
};

/** Handle ticket GET/POST orchestrator: render on GET, quote when in calculate
 * mode, otherwise submit. */
export const handleTicket = async (args: BookingRequest): Promise<Response> => {
  const { request, listings, mode } = args;
  const ctx = await buildTicketCtx(args);
  const response =
    request.method === "GET"
      ? ticketResponse(await renderCtx(ctx))(applyFlash(request).error)
      : mode === "calculate"
        ? await calculateTicket(request, ctx)
        : await submitTicket(request, ctx);
  return applyHiddenNoindex(
    response,
    listings.some((e) => e.listing.hidden) ||
      [...ctx.childrenByParentId.values()].flat().some((c) => c.listing.hidden),
  );
};

/**
 * Build a booking pre-fill from query params: per-listing quantities from
 * `?q_<id>=n` (the order page redirects into `/ticket/<slugs>?q_<id>=1…` to
 * land the visitor with their chosen items selected) and the date selector
 * from `?date=YYYY-MM-DD` (the /listings date filter carries the searched
 * date into a daily listing's Book CTA, #51).
 */
const parseQuantityPrefill = (
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
  if (map.size === 0 && date === null) return undefined;
  return { listings: map, ...(date !== null ? { date } : {}) };
};

/**
 * Handle a booking page by slugs (multi-listing). `mode` selects between
 * completing the booking (the default) and pricing it as a `/calculate`
 * running-total quote; both load the same active listings and share one
 * rendering/submission path.
 */
export const handleBySlugs = (
  request: Request,
  slugs: string[],
  mode?: "calculate",
): Promise<Response> =>
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
 * The booking-page framework entrypoint: render a booking page for an arbitrary
 * set of listings, letting {@link getTicketContext} derive the fields, dates,
 * questions and terms from the listings themselves. Every booking scenario
 * funnels through here — single listing, multi-listing, group, and the order
 * page — so they share one rendering and submission path.
 *
 * Caller supplies the listings; `group` flows into getTicketContext, `overrides`
 * win over its result (e.g. renewal's actionUrl/siteToken, or the order page's
 * header + action), and `prefill` pre-selects per-listing quantities (the order
 * cart's selected products). `mode` carries through to {@link handleTicket} so a
 * group quote prices via the same flow as a group booking.
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
      prefill: options.prefill,
      request,
      slugs,
    });
  };
