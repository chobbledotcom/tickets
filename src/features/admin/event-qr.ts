/**
 * Admin route for generating pre-filled booking QR codes for an event.
 *
 * GET renders the form, POST validates input, signs a URL, and re-renders
 * the page with the generated QR beneath the form.
 *
 * GET /admin/event/:id/qr.json returns a fresh token as JSON so the page
 * can refresh the QR client-side (every minute) without a full reload.
 */

import { withEntityLoader } from "#routes/admin/entity-handlers.ts";
import { requireSessionOr } from "#routes/auth.ts";
import { htmlResponse, jsonResponse } from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import {
  createAuthedFormRoute,
  type FormValidator,
} from "#shared/app-forms.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { validatePrice } from "#shared/currency.ts";
import { getAvailableDates } from "#shared/dates.ts";
import { getEventWithCount } from "#shared/db/events.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { FormParams } from "#shared/form-data.ts";
import { eventSupportsDirectCheckout, generateQrSvg } from "#shared/qr.ts";
import { buildQrBookPayload, signQrBookToken } from "#shared/qr-token.ts";
import type { AdminSession, EventWithCount } from "#shared/types.ts";
import type {
  AdminEventQrResult,
  AdminEventQrValues,
} from "#templates/admin/event-qr.tsx";
import { adminEventQrPage } from "#templates/admin/event-qr.tsx";

const EMPTY_VALUES: AdminEventQrValues = {
  customer_name: "",
  date: "",
  quantity: "1",
  value: "",
};

/** Load bookable dates for daily events (empty for standard events) */
const loadBookableDates = async (event: EventWithCount): Promise<string[]> => {
  if (event.event_type !== "daily") return [];
  const holidays = await getActiveHolidays();
  return getAvailableDates(event, holidays);
};

const withEvent = withEntityLoader(getEventWithCount);

/** Render the QR admin page; 404 when the event is missing */
const renderPage = (
  eventId: number,
  session: AdminSession,
  values: AdminEventQrValues,
  extras: { error?: string; result?: AdminEventQrResult } = {},
): Promise<Response> =>
  withEvent(eventId)(async (event) => {
    const [bookableDates, canDirectCheckout] = await Promise.all([
      loadBookableDates(event),
      eventSupportsDirectCheckout(event),
    ]);
    return htmlResponse(
      adminEventQrPage({
        bookableDates,
        canDirectCheckout,
        event,
        session,
        values,
        ...extras,
      }),
    );
  });

/** GET /admin/event/:id/qr */
const handleGet: TypedRouteHandler<"GET /admin/event/:id/qr"> = (
  request,
  { id },
) =>
  requireSessionOr(request, (session) => renderPage(id, session, EMPTY_VALUES));

/** Extract raw form values without validation */
const extractRawValues = (form: FormParams): AdminEventQrValues => ({
  customer_name: form.getString("customer_name").trim(),
  date: form.getString("date").trim(),
  quantity: form.getString("quantity").trim() || "1",
  value: form.getString("value").trim(),
});

/** Price range for an event: min/max allowed in minor units */
const getPriceBounds = (
  event: EventWithCount,
): { minPrice: number; maxPrice: number } => ({
  maxPrice: event.can_pay_more ? event.max_price : Number.MAX_SAFE_INTEGER,
  minPrice: event.can_pay_more ? event.unit_price : 0,
});

/** Build a form validator for the QR form, using event config for range checks */
const createQrFormValidator = (
  event: EventWithCount,
): FormValidator<AdminEventQrValues> => ({
  validate: (form) => {
    const values = extractRawValues(form);

    const quantity = Number.parseInt(values.quantity, 10);
    if (Number.isNaN(quantity) || quantity < 1) {
      return { error: "Quantity must be at least 1", valid: false };
    }
    if (quantity > event.max_quantity) {
      return {
        error: `Quantity cannot exceed ${event.max_quantity}`,
        valid: false,
      };
    }

    if (values.value) {
      const { minPrice, maxPrice } = getPriceBounds(event);
      const priceResult = validatePrice(values.value, minPrice, maxPrice);
      if (!priceResult.ok) {
        return { error: priceResult.error, valid: false };
      }
    }

    if (event.event_type === "daily" && !values.date) {
      return { error: "Date is required for daily events", valid: false };
    }

    return { valid: true, values };
  },
});

type ParsedValues = {
  name?: string;
  value?: number;
  quantity: number;
  date?: string;
};

/** Parse validated string values into the typed shape needed for token signing */
const parsedFromValues = (
  values: AdminEventQrValues,
  event: EventWithCount,
): ParsedValues => {
  const quantity = Number.parseInt(values.quantity, 10);
  let valueMinor: number | undefined;
  if (values.value) {
    const { minPrice, maxPrice } = getPriceBounds(event);
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

/** Sign a fresh token for the given event and render its QR SVG */
const signAndRenderQr = async (
  event: EventWithCount,
  parsed: ParsedValues,
): Promise<AdminEventQrResult> => {
  const payload = buildQrBookPayload(parsed);
  const token = await signQrBookToken(event.slug, payload);
  const url = buildQrUrl(event.slug, token);
  const svg = await generateQrSvg(url);
  return { svg, url };
};

/** Process a validated QR form submission and render the result panel */
const generateAndRender = async (
  id: number,
  session: AdminSession,
  event: EventWithCount,
  values: AdminEventQrValues,
): Promise<Response> => {
  const result = await signAndRenderQr(event, parsedFromValues(values, event));
  return renderPage(id, session, values, { result });
};

/** POST /admin/event/:id/qr */
const handlePost = createAuthedFormRoute<
  AdminEventQrValues,
  { id: number },
  EventWithCount
>({
  form: (event) => createQrFormValidator(event),
  loadContext: ({ id }) => getEventWithCount(id),
  onInvalid: ({ error, form, params, session }) =>
    renderPage(params.id, session, extractRawValues(form), { error }),
  onValid: ({ context: event, params, session, values }) =>
    generateAndRender(params.id, session, event, values),
});

/**
 * GET /admin/event/:id/qr.json
 *
 * Used by the admin page's client-side auto-refresh: it reads the current
 * form values, calls this endpoint, and swaps the rendered QR every minute
 * so stale links become obvious to any admin watching the screen.
 */
const handleJsonGet: TypedRouteHandler<"GET /admin/event/:id/qr.json"> = (
  request,
  { id },
) =>
  requireSessionOr(request, () =>
    withEvent(id)(async (event) => {
      const form = new FormParams(new URL(request.url).searchParams);
      const result = createQrFormValidator(event).validate(form);
      if (!result.valid) {
        return jsonResponse({ error: result.error, ok: false }, 400);
      }
      const qrResult = await signAndRenderQr(
        event,
        parsedFromValues(result.values, event),
      );
      return jsonResponse({ ok: true, ...qrResult });
    }),
  );

/** Exported admin routes for the QR generator */
export const eventQrRoutes = defineRoutes({
  "GET /admin/event/:id/qr": handleGet,
  "GET /admin/event/:id/qr.json": handleJsonGet,
  "POST /admin/event/:id/qr": handlePost,
});
