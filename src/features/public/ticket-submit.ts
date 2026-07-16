/**
 * Core ticket submission orchestrator
 */

import { applyFlash, withCsrfForm } from "#routes/csrf.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
} from "#routes/response.ts";
import { getBaseUrl } from "#routes/url.ts";
import type { TicketListing } from "#shared/booking/model.ts";
import { owedOrderForLedger } from "#shared/checkout-ledger.ts";
import {
  priceCheckout,
  ticketPaymentBreakdown,
} from "#shared/checkout-pricing.ts";
import { isPaymentsEnabled } from "#shared/config.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { formatCurrency } from "#shared/currency.ts";
import { parseIsoDateParam } from "#shared/dates.ts";
import {
  getGroupRemainingByListingId,
  getSharedGroupCapacities,
} from "#shared/db/attendees/capacity/groups.ts";
import { getSelectedAttributesForListings } from "#shared/db/attributes.ts";
import { listingGroups } from "#shared/db/groups.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { getImagesForItem } from "#shared/db/images.ts";
/* jscpd:ignore-start */
import {
  ATTENDEE_DEMO_FIELDS,
  applyDemoOverrides,
} from "#shared/demo/overrides.ts";
import type { FormParams } from "#shared/form-data.ts";
/* jscpd:ignore-end */
import type { CheckoutIntent } from "#shared/payments.ts";
import type { Group, ListingWithCount } from "#shared/types.ts";
import { parsePositiveInt } from "#shared/validation/number.ts";
import {
  orderSummary,
  orderSummaryMessage,
} from "#templates/public/order-summary.tsx";
import type {
  BookingPrefill,
  TicketPrefill,
} from "#templates/public/reservations/types.ts";
import {
  applyBookingPageParentSoldOut,
  childCapacityInfo,
} from "./discovery.ts";
/* jscpd:ignore-start */
import {
  extractContact,
  ticketFormErrorResponse,
  ticketResponse,
} from "./ticket-form.ts";
import { buildTicketListingsWithGroupCapacity } from "./ticket-listings.ts";
import { ticketPageUrl } from "./ticket-page-url.ts";
import {
  allChildListings,
  checkAvailability,
  dropChildListings,
  getTicketContext,
  withActiveListings,
} from "./ticket-payment.ts";
/* jscpd:ignore-end */
import { validateTicketFields } from "./ticket-submit/parse.ts";
import {
  handleFreePath,
  handlePaidPath,
  TICKETS_UNAVAILABLE_MESSAGE,
} from "./ticket-submit/paths.ts";
import {
  type PrepareResult,
  prepareOrder,
  singleListingThankYouUrl,
} from "./ticket-submit/prepare.ts";
import {
  checkSoldOutTiers,
  priceSubmissionWithContact,
  validatePaymentUpgrade,
} from "./ticket-submit/pricing.ts";
import {
  applyHiddenNoindex,
  type TicketContextProvider,
  type TicketCtx,
  type TicketSharedContext,
} from "./types.ts";

/** A parsed-and-priced order (the ok branch of {@link prepareOrder}). */
type PreparedOrder = Extract<PrepareResult, { ok: true }>;

/** Parse-and-price the submitted form, or map its failure message to a response
 *  via `onError` (a flash redirect for submit, an HTML fragment for the quote).
 *  Returns the priced order on success, or the already-formed error Response. */
const preparedOrderOr = async (
  ctx: TicketCtx,
  form: FormParams,
  onError: (message: string) => Response,
): Promise<PreparedOrder | Response> => {
  const prepared = await prepareOrder(ctx, form);
  return prepared.ok ? prepared : onError(prepared.error);
};

/** Process submitted form after CSRF and demo overrides. */
const processSubmission = async (
  request: Request,
  ctx: TicketCtx,
  form: FormParams,
): Promise<Response> => {
  const errorResponse = ticketFormErrorResponse(ctx);

  const prepared = await preparedOrderOr(ctx, form, errorResponse);
  if (prepared instanceof Response) return prepared;
  const { allocations, pricingParams, pricedOrder } = prepared;
  const { date, dayCount, hasCustomisable, info, quantities } = pricingParams;
  // The folded ctx carries the page listings plus the selected children, so it
  // drives contact-field requirements, availability, and reservation creation.
  // The original page ctx still determines the thank-you redirect so folding a
  // child doesn't drop a single parent's configured URL.
  const foldedCtx = pricingParams.ctx;
  const thankYouUrl = singleListingThankYouUrl(ctx);

  const paymentsEnabled = isPaymentsEnabled();
  const requiresPaidFields = pricedOrder.total > 0;
  const validated = validateTicketFields(form, foldedCtx, requiresPaidFields);
  if (validated instanceof Response) return validated;
  let contact = extractContact(validated);
  let {
    intent,
    pricedOrder: finalPricedOrder,
    visits,
  } = await priceSubmissionWithContact(contact, pricingParams);
  const paidUpgradeValidation = validatePaymentUpgrade(
    form,
    foldedCtx,
    requiresPaidFields,
    finalPricedOrder.total > 0,
  );
  if (paidUpgradeValidation instanceof Response) return paidUpgradeValidation;
  if (paidUpgradeValidation) {
    contact = extractContact(paidUpgradeValidation);
    ({
      intent,
      pricedOrder: finalPricedOrder,
      visits,
    } = await priceSubmissionWithContact(contact, pricingParams));
  }

  // Run the sold-out check at the buyer's real visit count (now known), so a
  // tier that wouldn't apply — cart below its minimum, or too few visits — isn't
  // reported sold out.
  const soldOut = await checkSoldOutTiers(pricingParams, visits);
  if (soldOut) return errorResponse(soldOut);

  const finalRequiresPaidFields = finalPricedOrder.total > 0;
  const finalRequiresPayment = paymentsEnabled && finalRequiresPaidFields;

  if (finalRequiresPayment) {
    // Carry a single parent's configured thank-you URL through the paid round-trip.
    // Folding a required child makes the booking multi-listing, so the webhook's
    // single-unique-listing-id derivation would otherwise drop the parent's URL.
    // Setting it explicitly on the
    // intent lets the success page prefer it over that derivation. Only needed
    // once a child was actually folded (the order gained a listing); a genuine
    // single-listing order still resolves the same URL by the default rule.
    if (thankYouUrl && foldedCtx.listings.length > ctx.listings.length) {
      intent.thankYouUrl = thankYouUrl;
    }
    if (allocations.length > 0) {
      intent.allocations = allocations;
    }
    return handlePaidPath(request, {
      ctx: foldedCtx,
      date,
      dayCount,
      info,
      intent,
      quantities,
    });
  }
  // With no payment provider configured we still accept bookings for paid items.
  // The order is recorded exactly like a zero-deposit reservation: nothing is
  // collected up front and the full value of the booking becomes the amount
  // owed. Forcing reservationAmount to "0" charges every line zero while the
  // remaining balance captures the full order value — regardless of any
  // reservation amount the public-default status configures, since no deposit
  // can be taken without a provider.
  const breakdownIntent: CheckoutIntent = paymentsEnabled
    ? intent
    : { ...intent, reservationAmount: "0" };
  // The ledger order for a provider-less booking is the breakdown order with the
  // booking fee removed up front (`feeSubtotal: 0` — payments-off charges no fee)
  // and then recast as an OWED order: nothing was collected and no fee is booked,
  // so `owedOrderForLedger` drops every extra and zeroes the total. That posts the
  // gross `sale`/owed legs (and any surcharge add-on as its own `modifier` leg)
  // with NO `fee` and NO `payment` leg — the breakdown intent (kept fee-bearing)
  // still drives the displayed remaining balance below.
  const ledgerOrder = paymentsEnabled
    ? finalPricedOrder
    : owedOrderForLedger(priceCheckout({ ...breakdownIntent, feeSubtotal: 0 }));
  return handleFreePath({
    allocations,
    contact,
    ctx: foldedCtx,
    date,
    dayCount,
    hasCustomisable,
    info,
    items: pricingParams.items,
    // Always dual-write the ledger — outstanding balance is projected from it,
    // so an owed booking must record its legs at creation. A paid or enabled
    // zero-total checkout (fully discounted, zero-deposit reservation) posts
    // `finalPricedOrder`; a provider-less booking posts the OWED order built
    // above, whose gross sale legs leave the full value owed with no fee/payment.
    ledgerOrder,
    // Record modifier usage (and consume stock) on every completion, including
    // bookings taken with no payment provider, so a stock-limited answer tier is
    // capped across all bookings — not just the paid ones the webhook would have
    // consumed. The applied amounts are the real per-modifier impact: a
    // provider-less booking owes the full order value (modifiers included), so
    // its modifiers count exactly as a zero-deposit reservation's would.
    modifierUsages: finalPricedOrder.modifierApplications,
    paymentBreakdown: ticketPaymentBreakdown(breakdownIntent),
    quantities,
    thankYouUrl,
  });
};

/** A booking-page POST route: check the CSRF token, then hand the submitted
 * form to `handle`. `onCsrfError` shapes the failure response for the route's
 * medium (a redirect for the full submit, an HTML fragment for the quote). */
const ticketFormRoute =
  (
    onCsrfError: (ctx: TicketCtx) => (message: string) => Response,
    handle: (
      request: Request,
      ctx: TicketCtx,
      form: FormParams,
    ) => Promise<Response>,
  ) =>
  (request: Request, ctx: TicketCtx): Promise<Response> =>
    withCsrfForm(request, onCsrfError(ctx), (form) =>
      handle(request, ctx, form),
    );

/** Handle POST for ticket registration */
const submitTicket = ticketFormRoute(
  // CSRF failures redirect with a flash (the token expired or was tampered
  // with — the page reloads with a fresh token). Field-level validation
  // errors instead re-render inline so the visitor keeps what they entered.
  (ctx) => (message) => errorRedirect(ticketPageUrl(ctx), message),
  (request, ctx, form) => {
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
 *   but a paid order still owes its full value (see {@link handleFreePath}), so
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
  const prepared = await preparedOrderOr(ctx, form, (message) =>
    htmlResponse(orderSummaryMessage(message)),
  );
  if (prepared instanceof Response) return prepared;
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
const calculateTicket = ticketFormRoute(
  () => (message) => htmlResponse(orderSummaryMessage(message), 403),
  (_request, ctx, form) => renderQuote(ctx, form),
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
  const children = allChildListings(ctx.childrenByParentId);
  const [
    childCaps,
    childOwnRemaining,
    holidays,
    membership,
    galleryImages,
    attributesByListing,
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
      allChildListings(ctx.childrenByParentId).some(
        (listing) => listing.hidden,
      ),
  );
};

/**
 * Build a booking pre-fill from query params: per-listing quantities from
 * `?q_<id>=n` (the order page redirects into `/ticket/<slugs>?q_<id>=1…` to
 * land the visitor with their chosen items selected) and the date selector
 * from `?date=YYYY-MM-DD` (the /listings date filter carries the searched
 * date into a daily listing's Book CTA, #51). A package needs no count
 * pre-fill — its selector already defaults to one bundle.
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
  if (map.size === 0 && date === null) return;
  return { listings: map, ...(date !== null ? { date } : {}) };
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
      // A caller-supplied pre-fill wins; otherwise read the query pre-fill so
      // e.g. the order cart's chosen date carries onto a package page.
      prefill: options.prefill ?? parseQuantityPrefill(request, activeListings),
      request,
      slugs,
    });
  };
