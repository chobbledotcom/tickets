/**
 * Scan handler for signed booking QR links.
 *
 * Verifies a signed token; on success, either skips straight to Stripe
 * checkout (when the token carries a name + value and the event requires
 * no extra fields or questions) or renders the normal booking page
 * with the token's values pre-filled.
 */

import { getAvailableDates } from "#lib/dates.ts";
import { getEventWithCountBySlug } from "#lib/db/events.ts";
import { getActiveHolidays } from "#lib/db/holidays.ts";
import { getQuestionsForEvent } from "#lib/db/questions.ts";
import { parseEventFields } from "#lib/event-fields.ts";
import type { CheckoutIntent } from "#lib/payments.ts";
import { type QrBookPayload, verifyQrBookToken } from "#lib/qr-token.ts";
import type { EventWithCount } from "#lib/types.ts";
import { htmlResponse, isRegistrationClosed } from "#routes/utils.ts";
import {
  buildTicketEvent,
  qrBookErrorPage,
  type QrPrefill,
  type TicketPrefill,
} from "#templates/public.tsx";
import { getTicketContext, runCheckoutFlow } from "./ticket-payment.ts";
import { handleTicket } from "./ticket-submit.ts";

const errorResponse = (slug: string, status: number): Response =>
  htmlResponse(qrBookErrorPage(slug), status);

/** Build per-event prefill entries from a QR payload */
const buildEventPrefills = (
  event: EventWithCount,
  payload: QrBookPayload,
): Map<number, TicketPrefill> => {
  const entry: TicketPrefill = { quantity: payload.q };
  if (payload.v >= 0 && event.can_pay_more) {
    entry.customPriceMinor = payload.v;
  }
  return new Map([[event.id, entry]]);
};

/** Build the QrPrefill context for the ticket page */
const buildPrefill = (
  event: EventWithCount,
  payload: QrBookPayload,
  token: string,
): QrPrefill => ({
  date: payload.d || undefined,
  events: buildEventPrefills(event, payload),
  name: payload.n || undefined,
  token,
});

/** Check whether the scan should skip straight to Stripe checkout.
 * Pre-requisites enforced by the caller: event is loaded, and for daily
 * events the payload date has been validated against bookable dates. */
const canSkipToCheckout = async (
  event: EventWithCount,
  payload: QrBookPayload,
): Promise<boolean> => {
  if (!payload.n || payload.v < 0) return false;
  if (parseEventFields(event.fields).length > 0) return false;
  const questions = await getQuestionsForEvent(event.id);
  return questions.length === 0;
};

/** Validate a daily-event booking date against available dates (minus holidays) */
const isDailyDateBookable = async (
  event: EventWithCount,
  date: string,
): Promise<boolean> => {
  if (!date) return false;
  const holidays = await getActiveHolidays();
  return getAvailableDates(event, holidays).includes(date);
};

/** Construct a CheckoutIntent for a single-event direct-to-Stripe booking */
const buildCheckoutIntent = (
  event: EventWithCount,
  payload: QrBookPayload,
): CheckoutIntent => ({
  address: "",
  date: event.event_type === "daily" ? payload.d : null,
  email: "",
  items: [
    {
      eventId: event.id,
      name: event.name,
      quantity: payload.q,
      slug: event.slug,
      unitPrice: payload.v,
    },
  ],
  name: payload.n,
  phone: "",
  special_instructions: "",
});

/** Redirect directly to Stripe checkout using the signed values */
const skipToCheckout = (
  request: Request,
  event: EventWithCount,
  payload: QrBookPayload,
): Promise<Response> => {
  const intent = buildCheckoutIntent(event, payload);
  return runCheckoutFlow(
    `qr-book event=${event.id}`,
    request,
    (provider, baseUrl) => provider.createCheckoutSession(intent, baseUrl),
    () => errorResponse(event.slug, 500),
  );
};

/** Once the token is verified and the event loaded, render or redirect */
const dispatchVerified = async (
  request: Request,
  slug: string,
  token: string,
  payload: QrBookPayload,
  event: EventWithCount,
): Promise<Response> => {
  if (
    event.event_type === "daily" &&
    !(await isDailyDateBookable(event, payload.d))
  ) {
    return errorResponse(slug, 400);
  }
  if (await canSkipToCheckout(event, payload)) {
    return skipToCheckout(request, event, payload);
  }
  const ticketEvent = buildTicketEvent(event, isRegistrationClosed(event));
  const prefill = buildPrefill(event, payload, token);
  return handleTicket(
    request,
    [slug],
    [ticketEvent],
    getTicketContext,
    prefill,
  );
};

/** GET /ticket/:slug/qr-book */
export const handleQrBookGet = async (
  request: Request,
  params: { slug: string },
): Promise<Response> => {
  const { slug } = params;
  const token = new URL(request.url).searchParams.get("t") ?? "";
  if (!token) return errorResponse(slug, 400);
  const payload = await verifyQrBookToken(slug, token);
  if (!payload) return errorResponse(slug, 400);
  const event = await getEventWithCountBySlug(slug);
  if (!event || !event.active) return errorResponse(slug, 404);
  return dispatchVerified(request, slug, token, payload, event);
};
