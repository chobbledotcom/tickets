/**
 * Admin route for generating pre-filled booking QR codes for an event.
 *
 * GET renders the form, POST validates input, signs a URL, and re-renders
 * the page with the generated QR beneath the form.
 */

import { getEffectiveDomain } from "#lib/config.ts";
import { validatePrice } from "#lib/currency.ts";
import { getAvailableDates } from "#lib/dates.ts";
import { getEventWithCount } from "#lib/db/events.ts";
import { getActiveHolidays } from "#lib/db/holidays.ts";
import type { FormParams } from "#lib/form-data.ts";
import { generateQrSvg } from "#lib/qr.ts";
import { buildQrBookPayload, signQrBookToken } from "#lib/qr-token.ts";
import type { AdminSession, EventWithCount } from "#lib/types.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  AUTH_FORM,
  htmlResponse,
  orNotFound,
  requireSessionOr,
  withAuth,
} from "#routes/utils.ts";
import {
  adminEventQrPage,
  type AdminEventQrResult,
  type AdminEventQrValues,
} from "#templates/admin/event-qr.tsx";

const EMPTY_VALUES: AdminEventQrValues = {
  customerName: "",
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

/** Render the QR admin page; 404 when the event is missing */
const renderPage = (
  eventId: number,
  session: AdminSession,
  values: AdminEventQrValues,
  extras: { error?: string; result?: AdminEventQrResult } = {},
): Promise<Response> =>
  orNotFound(Promise.resolve(getEventWithCount(eventId)), async (event) => {
    const bookableDates = await loadBookableDates(event);
    return htmlResponse(
      adminEventQrPage({
        bookableDates,
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

/** Extract and validate form values. Returns a parsed shape or an error string. */
const extractValues = (
  form: FormParams,
  event: EventWithCount,
):
  | { ok: true; parsed: ParsedValues; values: AdminEventQrValues }
  | {
    ok: false;
    error: string;
    values: AdminEventQrValues;
  } => {
  const values: AdminEventQrValues = {
    customerName: form.getString("customer_name").trim(),
    date: form.getString("date").trim(),
    quantity: form.getString("quantity").trim() || "1",
    value: form.getString("value").trim(),
  };

  const quantity = Number.parseInt(values.quantity, 10);
  if (Number.isNaN(quantity) || quantity < 1) {
    return { error: "Quantity must be at least 1", ok: false, values };
  }
  if (quantity > event.max_quantity) {
    return {
      error: `Quantity cannot exceed ${event.max_quantity}`,
      ok: false,
      values,
    };
  }

  let valueMinor: number | undefined;
  if (values.value) {
    const minPrice = event.can_pay_more ? event.unit_price : 0;
    const maxPrice = event.can_pay_more
      ? event.max_price
      : Number.MAX_SAFE_INTEGER;
    const priceResult = validatePrice(values.value, minPrice, maxPrice);
    if (!priceResult.ok) {
      return { error: priceResult.error, ok: false, values };
    }
    valueMinor = priceResult.price;
  }

  if (event.event_type === "daily" && !values.date) {
    return {
      error: "Date is required for daily events",
      ok: false,
      values,
    };
  }

  return {
    ok: true,
    parsed: {
      date: values.date || undefined,
      name: values.customerName || undefined,
      quantity,
      value: valueMinor,
    },
    values,
  };
};

type ParsedValues = {
  name?: string;
  value?: number;
  quantity: number;
  date?: string;
};

/** Build the absolute URL the QR encodes */
const buildQrUrl = (slug: string, token: string): string => {
  const domain = getEffectiveDomain();
  return `https://${domain}/ticket/${slug}/qr-book?t=${
    encodeURIComponent(token)
  }`;
};

/** Process a validated admin QR form submission and render the result panel */
const generateAndRender = async (
  id: number,
  session: AdminSession,
  event: EventWithCount,
  extracted: Extract<ReturnType<typeof extractValues>, { ok: true }>,
): Promise<Response> => {
  const payload = buildQrBookPayload(extracted.parsed);
  const token = await signQrBookToken(event.slug, payload);
  const url = buildQrUrl(event.slug, token);
  const svg = await generateQrSvg(url);
  return renderPage(id, session, extracted.values, { result: { svg, url } });
};

/** POST /admin/event/:id/qr */
const handlePost: TypedRouteHandler<"POST /admin/event/:id/qr"> = (
  request,
  { id },
) =>
  withAuth(
    request,
    AUTH_FORM,
    (session, form) =>
      orNotFound(Promise.resolve(getEventWithCount(id)), (event) => {
        const extracted = extractValues(form, event);
        return extracted.ok
          ? generateAndRender(id, session, event, extracted)
          : renderPage(id, session, extracted.values, {
            error: extracted.error,
          });
      }),
  );

/** Exported admin routes for the QR generator */
export const eventQrRoutes = defineRoutes({
  "GET /admin/event/:id/qr": handleGet,
  "POST /admin/event/:id/qr": handlePost,
});
