/**
 * Shared booking logic — context-independent core used by both
 * the web UI (public.ts) and the JSON API (api.ts).
 *
 * Takes validated inputs, returns a plain result object.
 * Callers handle input parsing/validation and response formatting.
 */

import { isPaymentsEnabled } from "#lib/config.ts";
import { createAttendeeAtomic, hasAvailableSpots } from "#lib/db/attendees.ts";
import type { RegistrationIntent } from "#lib/payments.ts";
import { getActivePaymentProvider } from "#lib/payments.ts";
import type { Attendee, ContactInfo, EventWithCount } from "#lib/types.ts";
import { logAndNotifyRegistration } from "#lib/webhook.ts";

/** Booking result — callers map this to their response format */
export type BookingResult =
  | { type: "success"; attendee: Attendee }
  | { type: "checkout"; checkoutUrl: string }
  | { type: "sold_out" }
  | { type: "checkout_failed"; error?: string }
  | {
      type: "creation_failed";
      reason: "capacity_exceeded" | "encryption_error";
    };

/** Check if a booking requires payment */
const needsPayment = (
  event: EventWithCount,
  customUnitPrice: number | undefined,
): boolean => {
  const paymentsEnabled = isPaymentsEnabled();
  return (
    (paymentsEnabled && event.unit_price > 0) ||
    (customUnitPrice !== undefined && customUnitPrice > 0 && paymentsEnabled)
  );
};

/** Handle the paid checkout path */
const processPaidBooking = async (
  event: EventWithCount,
  contact: ContactInfo,
  quantity: number,
  date: string | null,
  baseUrl: string,
  customUnitPrice?: number,
  answerIds?: number[],
): Promise<BookingResult> => {
  const available = await hasAvailableSpots(event.id, quantity, date);
  if (!available) return { type: "sold_out" };

  // Provider is guaranteed to exist when isPaymentsEnabled() is true
  const provider = await getActivePaymentProvider();
  if (!provider) return { type: "checkout_failed" };

  const intent: RegistrationIntent = {
    eventId: event.id,
    ...contact,
    quantity,
    date,
    customUnitPrice,
    answerIds,
  };

  const result = await provider.createCheckoutSession(event, intent, baseUrl);
  if (!result) return { type: "checkout_failed" };
  if ("error" in result)
    return { type: "checkout_failed", error: result.error };

  return { type: "checkout", checkoutUrl: result.checkoutUrl };
};

/** Handle the free booking path */
const processFreeBooking = async (
  event: EventWithCount,
  contact: ContactInfo,
  quantity: number,
  date: string | null,
): Promise<BookingResult> => {
  const result = await createAttendeeAtomic({
    eventId: event.id,
    ...contact,
    quantity,
    date,
  });

  if (!result.success)
    return { type: "creation_failed", reason: result.reason };

  await logAndNotifyRegistration([{ event, attendee: result.attendee }]);
  return { type: "success", attendee: result.attendee };
};

/**
 * Process a single-event booking.
 *
 * Determines whether payment is needed, then either:
 * - Creates a checkout session (paid) or
 * - Atomically creates an attendee (free)
 */
export const processBooking = async (
  event: EventWithCount,
  contact: ContactInfo,
  quantity: number,
  date: string | null,
  baseUrl: string,
  customUnitPrice?: number,
  answerIds?: number[],
): Promise<BookingResult> =>
  needsPayment(event, customUnitPrice)
    ? processPaidBooking(
        event,
        contact,
        quantity,
        date,
        baseUrl,
        customUnitPrice,
        answerIds,
      )
    : processFreeBooking(event, contact, quantity, date);
