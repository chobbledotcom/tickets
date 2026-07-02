/**
 * Admin route for generating pre-filled booking QR codes for an listing.
 *
 * GET renders the form, POST validates input, signs a URL, and re-renders
 * the page with the generated QR beneath the form.
 *
 * GET /admin/listing/:id/qr.json returns a fresh token as JSON so the page
 * can refresh the QR client-side (every minute) without a full reload.
 */

import { withEntityLoader } from "#routes/admin/entity-handlers.ts";
import { requireSessionOr } from "#routes/auth.ts";
import {
  constrainParentDailyDates,
  lacksStandalonePublicPage,
} from "#routes/public/ticket-payment.ts";
import {
  htmlResponse,
  jsonResponse,
  notFoundResponse,
} from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import {
  createAuthedFormRoute,
  type FormValidator,
} from "#shared/app-forms.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { validatePrice } from "#shared/currency.ts";
import { getBookableStartDates } from "#shared/dates.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { getListingWithCount } from "#shared/db/listings.ts";
import { FormParams } from "#shared/form-data.ts";
import { generateQrSvg, listingSupportsDirectCheckout } from "#shared/qr.ts";
import { buildQrBookPayload, signQrBookToken } from "#shared/qr-token.ts";
import type { AdminSession, ListingWithCount } from "#shared/types.ts";
import { parsePositiveInt } from "#shared/validation/number.ts";
import type {
  AdminListingQrResult,
  AdminListingQrValues,
} from "#templates/admin/listing-qr.tsx";
import { adminListingQrPage } from "#templates/admin/listing-qr.tsx";

const EMPTY_VALUES: AdminListingQrValues = {
  customer_name: "",
  date: "",
  quantity: "1",
  value: "",
};

/** Load bookable dates for daily listings (empty for standard listings).
 * Customisable listings use single-day availability — the visitor chooses the
 * span on the booking form — so every individually-bookable start is offered.
 *
 * When the listing is a parent, the offered dates are constrained to those at
 * least one required child can serve for the inherited span (Fix 2,
 * `constrainParentDailyDates`) — the same union the scanned booking form
 * enforces — so an admin can't mint a QR for a date the child-constrained
 * booking form would reject. A no-op for a daily listing with no child edges. */
const loadBookableDates = async (
  listing: ListingWithCount,
): Promise<string[]> => {
  if (listing.listing_type !== "daily") return [];
  const holidays = await getActiveHolidays();
  return constrainParentDailyDates(
    listing,
    getBookableStartDates(listing, holidays),
    holidays,
  );
};

const withListing = withEntityLoader(getListingWithCount);

/** Run `fn` only when `listing` has a standalone booking entry point; otherwise
 * 404. A child (invariant I3) and a hidden package's member both have no public
 * page — their /ticket slug 404s — so the QR generator (which signs
 * `/ticket/<slug>/qr-book`) would mint a dead-end link. No query for either when
 * the respective feature is off, so existing behaviour is unchanged. */
const unlessChild = async (
  listing: ListingWithCount,
  fn: () => Promise<Response>,
): Promise<Response> =>
  (await lacksStandalonePublicPage(listing.id)) ? notFoundResponse() : fn();

/** A listing with its child-constrained bookable date set (Fix 2), the context
 * the QR validator needs so a submitted date is checked against the same dates
 * the form offers. */
type QrContext = { listing: ListingWithCount; bookableDates: string[] };

/** Load a listing and its child-constrained bookable dates, or null when the
 * listing is missing. */
const loadQrContext = async (id: number): Promise<QrContext | null> => {
  const listing = await getListingWithCount(id);
  if (!listing) return null;
  return { bookableDates: await loadBookableDates(listing), listing };
};

/** Render the QR admin page; 404 when the listing is missing */
const renderPage = (
  listingId: number,
  session: AdminSession,
  values: AdminListingQrValues,
  extras: { error?: string; result?: AdminListingQrResult } = {},
): Promise<Response> =>
  withListing(listingId)((listing) =>
    unlessChild(listing, async () => {
      const [bookableDates, canDirectCheckout] = await Promise.all([
        loadBookableDates(listing),
        listingSupportsDirectCheckout(listing),
      ]);
      return htmlResponse(
        adminListingQrPage({
          bookableDates,
          canDirectCheckout,
          listing,
          session,
          values,
          ...extras,
        }),
      );
    }),
  );

/** GET /admin/listing/:id/qr */
const handleGet: TypedRouteHandler<"GET /admin/listing/:id/qr"> = (
  request,
  { id },
) =>
  requireSessionOr(request, (session) => renderPage(id, session, EMPTY_VALUES));

/** Extract raw form values without validation */
const extractRawValues = (form: FormParams): AdminListingQrValues => ({
  customer_name: form.getString("customer_name").trim(),
  date: form.getString("date").trim(),
  quantity: form.getString("quantity").trim() || "1",
  value: form.getString("value").trim(),
});

/** Price range for an listing: min/max allowed in minor units */
const getPriceBounds = (
  listing: ListingWithCount,
): { minPrice: number; maxPrice: number } => ({
  maxPrice: listing.can_pay_more ? listing.max_price : Number.MAX_SAFE_INTEGER,
  minPrice: listing.can_pay_more ? listing.unit_price : 0,
});

/**
 * Build a form validator for the QR form, using listing config for range checks.
 * `bookableDates` is the child-constrained date set the form offers (Fix 2): a
 * daily listing's submitted date must be one of them, so an admin can't sign a
 * QR for a date a required child can't serve (which the scanned booking form
 * would then reject) by posting a raw date past the dropdown.
 */
/** The error for a daily listing's submitted date, or null when it is allowed:
 * required, and one of the child-constrained `bookableDates` the form offers
 * (Fix 2). A no-op for a non-daily listing (which has no date control). */
const qrDateError = (
  listing: ListingWithCount,
  date: string,
  bookableDates: readonly string[],
): string | null => {
  if (listing.listing_type !== "daily") return null;
  if (!date) return "Date is required for daily listings";
  return bookableDates.includes(date) ? null : "Please select a valid date";
};

/** The error for the submitted price, or null: only checked when a value is
 * supplied, against the listing's min/max bounds. */
const qrPriceError = (
  listing: ListingWithCount,
  value: string,
): string | null => {
  if (!value) return null;
  const { minPrice, maxPrice } = getPriceBounds(listing);
  const priceResult = validatePrice(value, minPrice, maxPrice);
  return priceResult.ok ? null : priceResult.error;
};

const createQrFormValidator = (
  listing: ListingWithCount,
  bookableDates: readonly string[],
): FormValidator<AdminListingQrValues> => ({
  validate: (form) => {
    const values = extractRawValues(form);

    const quantity = parsePositiveInt(values.quantity);
    if (quantity === null) {
      return { error: "Quantity must be at least 1", valid: false };
    }
    if (quantity > listing.max_quantity) {
      return {
        error: `Quantity cannot exceed ${listing.max_quantity}`,
        valid: false,
      };
    }

    const error =
      qrPriceError(listing, values.value) ??
      qrDateError(listing, values.date, bookableDates);
    return error ? { error, valid: false } : { valid: true, values };
  },
});

type ParsedValues = {
  name?: string | undefined;
  value?: number | undefined;
  quantity: number;
  date?: string | undefined;
};

/** Parse validated string values into the typed shape needed for token signing */
const parsedFromValues = (
  values: AdminListingQrValues,
  listing: ListingWithCount,
): ParsedValues => {
  const quantity = parsePositiveInt(values.quantity)!;
  let valueMinor: number | undefined;
  if (values.value) {
    const { minPrice, maxPrice } = getPriceBounds(listing);
    const result = validatePrice(values.value, minPrice, maxPrice);
    if (result.ok) valueMinor = result.price;
  }
  return {
    date: values.date || undefined,
    name: values.customer_name || undefined,
    quantity,
    value: valueMinor,
  };
};

/** Build the absolute URL the QR encodes */
const buildQrUrl = (slug: string, token: string): string => {
  const domain = getEffectiveDomain();
  return `https://${domain}/ticket/${slug}/qr-book?t=${encodeURIComponent(
    token,
  )}`;
};

/** Sign a fresh token for the given listing and render its QR SVG */
const signAndRenderQr = async (
  listing: ListingWithCount,
  parsed: ParsedValues,
): Promise<AdminListingQrResult> => {
  const payload = buildQrBookPayload({
    quantity: parsed.quantity,
    ...(parsed.name !== undefined ? { name: parsed.name } : {}),
    ...(parsed.value !== undefined ? { value: parsed.value } : {}),
    ...(parsed.date !== undefined ? { date: parsed.date } : {}),
  });
  const token = await signQrBookToken(listing.slug, payload);
  const url = buildQrUrl(listing.slug, token);
  const svg = await generateQrSvg(url);
  return { svg, url };
};

/** Process a validated QR form submission and render the result panel */
const generateAndRender = async (
  id: number,
  session: AdminSession,
  listing: ListingWithCount,
  values: AdminListingQrValues,
): Promise<Response> =>
  unlessChild(listing, async () => {
    const result = await signAndRenderQr(
      listing,
      parsedFromValues(values, listing),
    );
    return renderPage(id, session, values, { result });
  });

/** POST /admin/listing/:id/qr */
const handlePost = createAuthedFormRoute<
  AdminListingQrValues,
  { id: number },
  QrContext
>({
  form: ({ bookableDates, listing }) =>
    createQrFormValidator(listing, bookableDates),
  loadContext: ({ id }) => loadQrContext(id),
  onInvalid: ({ error, form, params, session }) =>
    renderPage(params.id, session, extractRawValues(form), { error }),
  onValid: ({ context: { listing }, params, session, values }) =>
    generateAndRender(params.id, session, listing, values),
});

/**
 * GET /admin/listing/:id/qr.json
 *
 * Used by the admin page's client-side auto-refresh: it reads the current
 * form values, calls this endpoint, and swaps the rendered QR every minute
 * so stale links become obvious to any admin watching the screen.
 */
const handleJsonGet: TypedRouteHandler<"GET /admin/listing/:id/qr.json"> = (
  request,
  { id },
) =>
  requireSessionOr(request, () =>
    withListing(id)((listing) =>
      unlessChild(listing, async () => {
        const form = new FormParams(new URL(request.url).searchParams);
        const bookableDates = await loadBookableDates(listing);
        const result = createQrFormValidator(listing, bookableDates).validate(
          form,
        );
        if (!result.valid) {
          return jsonResponse({ error: result.error, ok: false }, 400);
        }
        const qrResult = await signAndRenderQr(
          listing,
          parsedFromValues(result.values, listing),
        );
        return jsonResponse({ ok: true, ...qrResult });
      }),
    ),
  );

/** Exported admin routes for the QR generator */
export const listingQrRoutes = defineRoutes({
  "GET /admin/listing/:id/qr": handleGet,
  "GET /admin/listing/:id/qr.json": handleJsonGet,
  "POST /admin/listing/:id/qr": handlePost,
});
