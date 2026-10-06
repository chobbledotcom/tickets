/* jscpd:ignore-start */
import { buildBookingTree } from "#booking/build-tree.ts";
import type { FoldBase, FoldChildrenResult } from "#booking/fold-tree.ts";
import { buildOrderLines, nodeQuantitiesFor } from "#booking/order-lines.ts";
import type { BookingTree } from "#booking/tree.ts";
import { sumOf } from "#fp";
import { apiError } from "#routes/api/cors.ts";
import {
  bookingSuccessResponse,
  checkoutFailedResponse,
  checkoutResponse,
  resolveCustomPrice,
  soldOutResponse,
  toFormParams,
} from "#routes/api/helpers.ts";
import {
  type ApiChildSelection,
  ChildrenSchema,
  type PackageChildrenSchema,
} from "#routes/api/request-schemas.ts";
import { createFreeReservation } from "#routes/public/free-reservation.ts";
import { buildTicketListingsWithGroupCapacity } from "#routes/public/ticket-listings.ts";
import {
  checkAvailability,
  ctxToBuildTreeInput,
  foldSelectedChildren,
  getTicketContext,
} from "#routes/public/ticket-payment.ts";
import type { TicketCtx } from "#routes/public/types.ts";
import { getBaseUrl } from "#routes/url.ts";
import { owedOrderForLedger } from "#shared/checkout-ledger.ts";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { isPaymentsEnabled } from "#shared/config.ts";
import type { FormParams } from "#shared/form-data.ts";
import { mergeListingFields } from "#shared/listing-fields.ts";
import {
  type CheckoutIntent,
  type CheckoutItem,
  getActivePaymentProvider,
} from "#shared/payments.ts";
import { parseOrNull } from "#shared/validation/parse.ts";
import { logAndNotifyRegistration } from "#shared/webhook/delivery.ts";
import {
  extractContact,
  type TicketFormValues,
  tryValidateTicketFields,
} from "#templates/fields/ticket.ts";
import { type ContactInfo, isPaidListing, type ListingWithCount } from "#types";
/* jscpd:ignore-end */

/** Parse the `children` array of a booking body against `schema`, or null (the
 * caller's 400) when it is present but malformed. */
export const parseApiChildSelections = (
  body: Record<string, unknown>,
  schema: typeof ChildrenSchema | typeof PackageChildrenSchema = ChildrenSchema,
): ApiChildSelection[] | null => parseOrNull(schema, body.children);

/** Translate one parent's resolved child selections into the `child_qty_*` /
 * `child_price_*` fields the shared fold reads on `form`. Each submitted slug
 * resolves against the parent's actual children (repeated slugs sum). A slug
 * that is not a child of this parent earns a 400 naming it. Repeated entries
 * for one child that disagree on the pay-more `customPrice` also earn a 400.
 * Null means the fields were applied cleanly. */
export const applyChildSelectionsToForm = (
  form: FormParams,
  ctx: TicketCtx,
  parentId: number,
  selections: ApiChildSelection[],
): Response | null => {
  // The parent's resolved children live on the ctx (ONE hydration pass).
  // Build the slug-to-child lookup here. Every caller (a single parent, each
  // member of a package) then reads the ctx the same way rather than
  // re-spelling the map.
  const childBySlug = new Map(
    (ctx.childrenByParentId.get(parentId) ?? []).map((c) => [
      c.listing.slug,
      c,
    ]),
  );
  const qtyByChild = new Map<number, number>();
  // The fold stores ONE `child_price_*` per child for its whole quantity. Two
  // entries for one child cannot both be honoured when their `customPrice`
  // values differ (or one sets a price and another leaves it default). A
  // plain `form.set` lets the last entry's price win and books every unit at
  // it. Track each child's submitted price and reject a conflict with a 400
  // rather than charging the wrong amount. A single aggregated entry, or
  // repeats agreeing on the price, is accepted.
  const priceByChild = new Map<number, number | undefined>();
  for (const selection of selections) {
    const child = childBySlug.get(selection.slug);
    if (!child) {
      return apiError(`'${selection.slug}' is not a child of this listing.`);
    }
    const childId = child.listing.id;
    if (
      priceByChild.has(childId) &&
      priceByChild.get(childId) !== selection.customPrice
    ) {
      return apiError(
        `Conflicting prices for '${selection.slug}'. Send one entry per child with a single price.`,
      );
    }
    priceByChild.set(childId, selection.customPrice);
    qtyByChild.set(
      childId,
      (qtyByChild.get(childId) ?? 0) + selection.quantity,
    );
    if (selection.customPrice !== undefined) {
      form.set(
        `child_price_${parentId}_${childId}`,
        String(selection.customPrice),
      );
    }
  }
  for (const [childId, qty] of qtyByChild) {
    form.set(`child_qty_${parentId}_${childId}`, String(qty));
  }
  return null;
};

/** The price (minor units) of a folded multi-item order. */
const foldedOrderTotal = (items: CheckoutItem[]): number =>
  sumOf((item: CheckoutItem) => item.unitPrice * item.quantity)(items);

/** The shared input to a folded booking: the contact, the chosen date, the
 * fold result, the priced order lines, and the parent's thank-you URL. The
 * URL rides only once the order gains a child. Both
 * {@link foldedIntent} and {@link completeFoldedBooking} read from this one
 * shape. The parent and package API booking flows therefore pass the same
 * bundle rather than re-spelling five parameters. */
type FoldedBookingInput = {
  contact: ContactInfo;
  date: string | null;
  fold: Extract<FoldChildrenResult, { ok: true }>;
  items: CheckoutItem[];
  /** The single parent's configured redirect: a folded order gains a child
   * listing, which the success page's single-listing derivation otherwise
   * drops. Honoured only when set AND a child was actually folded in (see
   * {@link foldedIntent}). A package passes nothing here. */
  parentThankYouUrl?: string;
};

/** The checkout intent for a folded order ({@link completeFoldedBooking}). The
 * chosen span rides only when a folded line is customisable. The webhook then
 * reprices and dates the booking by day count rather than defaulting to 1.
 * This mirrors the web path's conditional `dayCount` on its intent. */
const foldedIntent = (input: FoldedBookingInput): CheckoutIntent => {
  const { contact, date, fold, items, parentThankYouUrl } = input;
  return {
    ...contact,
    // Carry the per-(child,parent) allocations so the paid session signs them.
    // The webhook's edge-drift revalidation can then detect a parent-to-child
    // edge removed or re-parented mid-payment. buildMetadata omits an empty
    // array.
    allocations: fold.allocations,
    date,
    // Each package member line already carries its group id, signed per line as
    // the item's edge tag.
    items,
    ...(fold.hasCustomisable ? { dayCount: fold.dayCount } : {}),
    // Carry the parent's thank-you URL only once a child was actually folded in
    // (the order gained a listing). A multi-listing order cannot recover it
    // from the booked listing ids. A degenerate single-listing fold still
    // resolves the same URL by the success handler's default rule.
    ...(parentThankYouUrl && fold.listings.length > 1
      ? { thankYouUrl: parentThankYouUrl }
      : {}),
  };
};

/** Fold the selected children, bailing with the fold's own 400 response: a
 * child the buyer cannot pick, an over-capacity selection, or a conflicting
 * child price. Then build the per-path order lines from the tree with the
 * given node quantities. The standalone parent and package book flows share
 * this fold-then-build seam. */
export const foldAndBuildOrderLines = async (
  ctx: TicketCtx,
  form: FormParams,
  base: FoldBase,
  tree: BookingTree,
  nodeQuantities: Map<string, number>,
): Promise<
  | { fold: Extract<FoldChildrenResult, { ok: true }>; items: CheckoutItem[] }
  | Response
> => {
  const fold = await foldSelectedChildren(ctx, form, base, tree);
  if (!fold.ok) return apiError(fold.error);
  // The JSON API sells ordinary purchases: the web renewal page is the only
  // surface that carries a renewal context.
  const items = buildOrderLines(
    tree,
    nodeQuantities,
    fold.quantities,
    fold.customPrices,
    fold.dayCount,
    { renewal: false },
  );
  return { fold, items };
};

/** Validate a folded order's contact fields against the merged parent+child
 * field requirements, mapping a validation failure to a 400 response. The paid
 * flag is the caller's. The parent path reads paid-ness from the folded
 * listings (a standard listing's settings). The package path reads it from the
 * priced order lines (a package override can flip a member's paid-ness). */
const validateFoldedFields = (
  form: FormParams,
  fold: Extract<FoldChildrenResult, { ok: true }>,
  paid: boolean,
): TicketFormValues | Response =>
  tryValidateTicketFields(
    form,
    mergeListingFields(fold.listings.map((e) => e.listing.fields)),
    (msg) => apiError(msg),
    paid,
  );

/** Validate the folded order's contact fields, then charge or create it via
 * {@link completeFoldedBooking}. The parent and package API booking flows both
 * end here, so the validate-then-complete tail lives once. */
export const finishFoldedBooking = async (
  request: Request,
  form: FormParams,
  paid: boolean,
  order: Omit<FoldedBookingInput, "contact">,
): Promise<Response> => {
  const valResult = validateFoldedFields(form, order.fold, paid);
  if (valResult instanceof Response) return valResult;
  return completeFoldedBooking(request, {
    ...order,
    contact: extractContact(valResult),
  });
};

/** `parentThankYouUrl` exists because a folded child makes the order
 * multi-listing, so the success handler's single-listing-id derivation drops
 * the parent's configured redirect. The paid intent carries it instead.
 *
 * The caller conceals a HIDDEN package's per-path `items`, so the hosted
 * checkout never reveals a concealed member's name. */
const completeFoldedBooking = async (
  request: Request,
  input: FoldedBookingInput,
): Promise<Response> => {
  const { contact, date, fold, items } = input;
  const total = foldedOrderTotal(items);
  const intent = foldedIntent(input);
  if (isPaymentsEnabled() && total > 0) {
    // Reject a folded order whose parent or any child has exhausted capacity
    // before creating a checkout session. The web paid path runs the same
    // `checkAvailability` preflight. Without it, the API hands back a checkout
    // URL for a sold-out order the webhook cannot create.
    const available = await checkAvailability(
      fold.listings,
      fold.quantities,
      date,
      fold.dayCount,
    );
    if (!available) return soldOutResponse();
    const provider = (await getActivePaymentProvider())!;
    const baseUrl = getBaseUrl(request);
    const result = await provider.createCheckoutSession(intent, baseUrl);
    if (!result) return checkoutFailedResponse();
    return "error" in result
      ? checkoutFailedResponse(result.error)
      : checkoutResponse(result.checkoutUrl);
  }
  // Free, or provider-less paid (owes the full value). An owed order must record
  // its gross sale legs in the ledger at creation, because the outstanding
  // balance projects from them. So build the zeroed-total owed order the web
  // free path uses. A genuinely free order (payments enabled, total 0) owes
  // nothing and posts no legs.
  const remainingBalance = isPaymentsEnabled() ? 0 : total;
  const reservation = await createFreeReservation({
    allocations: fold.allocations,
    contact,
    date,
    dayCount: fold.dayCount,
    items,
    ledgerOrder:
      remainingBalance > 0
        ? owedOrderForLedger(priceCheckout({ ...intent, feeSubtotal: 0 }))
        : null,
    listings: fold.listings,
    modifierUsages: [],
    remainingBalance,
  });
  if (!reservation.success) return soldOutResponse();
  // Notify only after stock is committed, exactly like the standalone API booking
  // (`processBooking`) and the web free path (`handleFreePath`) do after
  // `createFreeReservation`. Without this, the folded free/provider-less
  // parent booking silently skips the confirmation email, registration webhook,
  // and activity log every other booking path fires.
  await logAndNotifyRegistration(reservation.entries);
  return bookingSuccessResponse(reservation.entries[0]!.attendee);
};

/**
 * Book a parent listing through the JSON API with its required children (per-unit
 * selection, mirroring the web fold). Resolve the chosen child slugs, fold
 * them into a multi-item order, and validate contact fields against the
 * merged parent+child requirements. A paid child can add Square's email. Then
 * charge (multi-item checkout) or create all rows all-or-nothing (free). The
 * parent/child pairing is recomputed at creation, so the parent and its
 * children are stored linked.
 */
export const processParentApiBooking = async (
  request: Request,
  listing: ListingWithCount,
  body: Record<string, unknown>,
  quantity: number,
  date: string | null,
): Promise<Response> => {
  // The API has no day-count input. A customisable parent (priced by a chosen
  // span its children inherit) therefore cannot be booked here, like a
  // customisable standalone listing.
  if (listing.customisable_days) {
    return apiError("This listing must be booked through the website.");
  }
  const selections = parseApiChildSelections(body);
  if (selections === null) {
    return apiError(
      "Provide a `children` array of { slug, quantity } totalling the booked quantity.",
    );
  }

  // Build the parent's ticket context (children + availability), then map the
  // submitted child slugs onto the fold's per-child quantity form.
  const [parentListing] = await buildTicketListingsWithGroupCapacity([listing]);
  const sharedCtx = await getTicketContext([parentListing!]);
  const ctx: TicketCtx = {
    ...sharedCtx,
    listings: [parentListing!],
    slugs: [listing.slug],
  };
  const form = toFormParams(body);
  const selectionError = applyChildSelectionsToForm(
    form,
    ctx,
    listing.id,
    selections,
  );
  if (selectionError) return selectionError;

  // A pay-more PARENT carries its own custom price: without seeding it the
  // fold prices the parent at its `unit_price` and undercharges. Resolve it the
  // same way the standalone path does and seed the fold's customPrices map. A
  // fixed-price parent contributes nothing here.
  const parentCustomPrice = resolveCustomPrice(listing, form);
  if (parentCustomPrice instanceof Response) return parentCustomPrice;
  const customPrices = new Map<number, number>();
  if (parentCustomPrice !== undefined) {
    customPrices.set(listing.id, parentCustomPrice);
  }

  const tree = buildBookingTree(ctxToBuildTreeInput(ctx));
  const built = await foldAndBuildOrderLines(
    ctx,
    form,
    {
      customPrices,
      date,
      dayCount: 1,
      hasCustomisable: false,
      quantities: new Map([[listing.id, quantity]]),
    },
    tree,
    nodeQuantitiesFor(tree, new Map([[listing.id, quantity]]), new Map()),
  );
  if (built instanceof Response) return built;
  const { fold, items } = built;
  // Contact fields validate against the MERGED parent+child requirements and the
  // folded paid-ness (a free parent with a paid child still needs Square's email).
  return finishFoldedBooking(
    request,
    form,
    fold.listings.some((e) => isPaidListing(e.listing)),
    {
      date,
      fold,
      items,
      // The fold always starts from this single parent, so its configured
      // thank-you URL is the one a folded order otherwise drops.
      parentThankYouUrl: listing.thank_you_url,
    },
  );
};
