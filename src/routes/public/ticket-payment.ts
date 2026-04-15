/**
 * Payment flow, availability checks, and free registration
 */

import { compact } from "#fp";
import { isPaymentsEnabled } from "#lib/config.ts";
import { getAvailableDates } from "#lib/dates.ts";
import type { CreateAttendeeResult } from "#lib/db/attendee-types.ts";
import {
  checkBatchAvailability,
  createAttendeeAtomic,
  deleteAttendee,
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
import type { ContactInfo, Group } from "#lib/types.ts";
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
import type {
  AsyncHandler,
  EventQty,
  TicketCtx,
  TicketSharedContext,
} from "./types.ts";

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
    buildBookings(eventsWithQuantity(events, quantities), date ?? null),
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
    name: event.name,
    quantity: quantities.get(event.id)!,
    slug: event.slug,
    unitPrice: customPrices.get(event.id) ?? event.unit_price,
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
/** Build booking objects from selected events */
const buildBookings = (
  selected: EventQty[],
  date: string | null,
): { eventId: number; quantity: number; date: string | null }[] =>
  selected.map(({ event, qty }) => ({
    date: event.event_type === "daily" ? date : null,
    eventId: event.id,
    quantity: qty,
  }));

/**
 * Check if a multi-booking result is incomplete (some events failed capacity).
 * If so, rolls back any partially-created attendee. Returns the failure reason.
 */
export const ensureAllBookings = async (
  result: CreateAttendeeResult,
  expectedCount: number,
): Promise<
  { ok: true } | { ok: false; reason: "capacity_exceeded" | "encryption_error" }
> => {
  if (result.success && result.attendees.length >= expectedCount) {
    return { ok: true };
  }
  if (result.success && result.attendees.length > 0) {
    await deleteAttendee(result.attendees[0]!.id);
  }
  return {
    ok: false,
    reason: result.success ? "capacity_exceeded" : result.reason,
  };
};

export const processFreeReservation = async (
  events: TicketEvent[],
  quantities: Map<number, number>,
  contact: ContactInfo,
  date: string | null,
): Promise<
  | { success: true; token: string; entries: EmailEntry[] }
  | { success: false; error: string }
> => {
  const selected = eventsWithQuantity(events, quantities);
  const bookings = buildBookings(selected, date);
  const result = await createAttendeeAtomic({ ...contact, bookings });

  const check = await ensureAllBookings(result, bookings.length);
  if (!check.ok) {
    return {
      error: formatAtomicError(check.reason, selected[0]!.event.name),
      success: false,
    };
  }
  // ensureAllBookings guarantees result.success after ok check
  const { attendees } = result as Extract<
    CreateAttendeeResult,
    { success: true }
  >;

  // Build entries: pair each attendee result with its event
  const entries: EmailEntry[] = attendees.map((attendee, i) => ({
    attendee,
    event: selected[i]!.event,
  }));

  await logAndNotifyRegistration(entries);
  return {
    entries,
    success: true,
    token: attendees[0]!.ticket_token,
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

/** Fetch shared context for ticket pages: dates, terms, questions.
 * When a group is provided, its terms override global terms and its name/description are included. */
export const getTicketContext = async (
  activeEvents: TicketEvent[],
  group?: Group,
): Promise<TicketSharedContext> => {
  const eventIds = activeEvents.map((e) => e.event.id);
  const [dates, globalTerms, questionsResult] = await Promise.all([
    computeSharedDates(activeEvents),
    Promise.resolve(settings.terms),
    getQuestionsWithEventIds(eventIds),
  ]);
  const terms = group
    ? group.terms_and_conditions || globalTerms || ""
    : globalTerms;
  return {
    dates,
    terms,
    ...questionsResult,
    ...(group && {
      groupDescription: group.description,
      groupName: group.name,
    }),
  };
};
