/**
 * Payment flow, availability checks, and free registration
 */

import { compact } from "#fp";
import { isPaymentsEnabled } from "#lib/config.ts";
import { getAvailableDates } from "#lib/dates.ts";
import {
  checkBatchAvailability,
  createAttendeeAtomic,
} from "#lib/db/attendees.ts";
import { getEventsBySlugsBatch } from "#lib/db/events.ts";
import { getActiveHolidays } from "#lib/db/holidays.ts";
import { getQuestionsWithEventIds } from "#lib/db/questions.ts";
import { settings } from "#lib/db/settings.ts";
import type { EmailEntry } from "#lib/email.ts";
import { logDebug } from "#lib/logger.ts";
import {
  type CheckoutIntent,
  type CheckoutItem,
  getActivePaymentProvider,
} from "#lib/payments.ts";
import type { ContactInfo } from "#lib/types.ts";
import { logAndNotifyRegistration } from "#lib/webhook.ts";
import {
  checkoutResponse,
  errorRedirect,
  getBaseUrl,
  isRegistrationClosed,
  notFoundResponse,
} from "#routes/utils.ts";
import { buildTicketEvent, type TicketEvent } from "#templates/public.tsx";
import { eventsWithQuantity, formatAtomicError } from "./ticket-form.ts";
import type { AsyncHandler, TicketCtx, TicketSharedContext } from "./types.ts";

/** Try to redirect to checkout, or return error using provided handler.
 * When in iframe mode, returns a popup page instead of redirect since Stripe cannot run in iframes. */
export const tryCheckoutRedirect = <T>(
  sessionUrl: string | undefined | null,
  errorHandler: () => T,
): Response | T => {
  if (!sessionUrl) return errorHandler();
  return checkoutResponse(sessionUrl);
};

/** Get active payment provider or return an error response */
export const withPaymentProvider = async (
  onMissing: () => Response,
  fn: (
    provider: Awaited<ReturnType<typeof getActivePaymentProvider>> & object,
  ) => Promise<Response>,
): Promise<Response> => {
  const provider = await getActivePaymentProvider();
  return provider ? fn(provider) : onMissing();
};

/** Generic checkout flow: resolve provider, create session, redirect or show error.
 * When in iframe mode, opens checkout in a popup window instead of redirect. */
export const runCheckoutFlow = (
  label: string,
  request: Request,
  createSession: (
    provider: Awaited<ReturnType<typeof getActivePaymentProvider>> & object,
    baseUrl: string,
  ) => Promise<import("#lib/payments.ts").CheckoutSessionResult>,
  onError: (msg: string, status: number) => Response,
): Promise<Response> => {
  logDebug("Payment", `Starting ${label} checkout`);
  return withPaymentProvider(
    () => {
      logDebug(
        "Payment",
        `No payment provider configured for ${label} checkout`,
      );
      return onError(
        "Payments are not configured. Please contact the administrator.",
        500,
      );
    },
    async (provider) => {
      logDebug("Payment", `Using provider=${provider.type} for ${label}`);
      const baseUrl = getBaseUrl(request);
      logDebug("Payment", `Creating checkout session baseUrl=${baseUrl}`);
      const result = await createSession(provider, baseUrl);
      if (result && "error" in result) {
        logDebug(
          "Payment",
          `Checkout validation error for ${label}: ${result.error}`,
        );
        return onError(result.error, 400);
      }
      logDebug(
        "Payment",
        `Checkout result for ${label}: ${result ? `url=${result.checkoutUrl}` : "null"}`,
      );
      return tryCheckoutRedirect(result?.checkoutUrl, () => {
        logDebug(
          "Payment",
          `Checkout redirect failed for ${label}: no session URL`,
        );
        return onError(
          "Failed to create payment session. Please try again.",
          500,
        );
      });
    },
  );
};

/** Check if all selected events have available spots (single efficient query) */
export const checkAvailability = (
  events: TicketEvent[],
  quantities: Map<number, number>,
  date?: string | null,
): Promise<boolean> =>
  checkBatchAvailability(
    eventsWithQuantity(events, quantities).map(({ event, qty }) => ({
      eventId: event.id,
      quantity: qty,
    })),
    date,
  );

/** Build registration items from events and quantities */
export const buildRegistrationItems = (
  events: TicketEvent[],
  quantities: Map<number, number>,
  customPrices: Map<number, number>,
): CheckoutItem[] => {
  const selected = events.filter(({ event }) => {
    const qty = quantities.get(event.id);
    return qty !== undefined && qty > 0;
  });
  return selected.map(({ event }) => ({
    eventId: event.id,
    quantity: quantities.get(event.id)!,
    unitPrice: customPrices.get(event.id) ?? event.unit_price,
    slug: event.slug,
    name: event.name,
  }));
};

/** Check if any selected event requires payment */
export const anyRequiresPayment = (items: CheckoutItem[]): boolean => {
  const paymentsEnabled = isPaymentsEnabled();
  if (!paymentsEnabled) return false;
  return items.some((item) => item.unitPrice > 0);
};

/** Handle payment flow for ticket purchase */
export const handlePaymentFlow = (
  request: Request,
  intent: CheckoutIntent,
  ctx: TicketCtx,
): Promise<Response> =>
  runCheckoutFlow(
    `ticket items=${intent.items.length}`,
    request,
    (provider, baseUrl) => provider.createCheckoutSession(intent, baseUrl),
    (msg) => errorRedirect(`/ticket/${ctx.slugs.join("+")}`, msg),
  );

/** Handle free ticket registration */
export const processFreeReservation = async (
  events: TicketEvent[],
  quantities: Map<number, number>,
  contact: ContactInfo,
  date: string | null,
): Promise<
  | { success: true; tokens: string[]; entries: EmailEntry[] }
  | { success: false; error: string }
> => {
  const entries: EmailEntry[] = [];
  for (const { event, qty } of eventsWithQuantity(events, quantities)) {
    const eventDate = event.event_type === "daily" ? date : null;
    const result = await createAttendeeAtomic({
      ...contact,
      bookings: [{ eventId: event.id, quantity: qty, date: eventDate }],
    });
    if (!result.success) {
      return {
        success: false,
        error: formatAtomicError(result.reason, event.name),
      };
    }
    entries.push({ event, attendee: result.attendees[0]! });
  }
  await logAndNotifyRegistration(entries);
  return {
    success: true,
    tokens: entries.map((entry) => entry.attendee.ticket_token),
    entries,
  };
};

/** Load and validate active events, return 404 if none */
export const withActiveEvents = async (
  slugs: string[],
  handler: AsyncHandler<[TicketEvent[]]>,
): Promise<Response> => {
  const events = await getEventsBySlugsBatch(slugs);
  const active = compact(events).filter((e) => e.active);
  const activeEvents = active.map((e) =>
    buildTicketEvent(e, isRegistrationClosed(e)),
  );
  return activeEvents.length === 0 ? notFoundResponse() : handler(activeEvents);
};

/** Compute shared available dates across all daily events (intersection) */
export const computeSharedDates = async (
  events: TicketEvent[],
): Promise<string[]> => {
  const dailyEvents = events.filter((e) => e.event.event_type === "daily");
  if (dailyEvents.length === 0) return [];
  const holidays = await getActiveHolidays();
  const dateSets = dailyEvents.map(
    (e) => new Set(getAvailableDates(e.event, holidays)),
  );
  return [...dateSets[0]!].filter((d) => dateSets.every((s) => s.has(d)));
};

/** Fetch shared context for ticket pages: dates, terms, questions */
export const getTicketContext = async (
  activeEvents: TicketEvent[],
): Promise<TicketSharedContext> => {
  const eventIds = activeEvents.map((e) => e.event.id);
  const [dates, terms, questionsResult] = await Promise.all([
    computeSharedDates(activeEvents),
    Promise.resolve(settings.terms),
    getQuestionsWithEventIds(eventIds),
  ]);
  return { dates, terms, ...questionsResult };
};
