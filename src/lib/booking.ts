/**
 * Shared booking logic — context-independent core used by both
 * the web UI (public.ts) and the JSON API (api.ts).
 *
 * Takes validated inputs, returns a plain result object.
 * Callers handle input parsing/validation and response formatting.
 */

import { getCurrencyCode, isPaymentsEnabled } from "#lib/config.ts";
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
): Promise<BookingResult> => {
  const paymentsEnabled = await isPaymentsEnabled();
  const needsPayment =
    (paymentsEnabled && event.unit_price > 0) ||
    (customUnitPrice !== undefined && customUnitPrice > 0 && paymentsEnabled);

  if (needsPayment) {
    const available = await hasAvailableSpots(event.id, quantity, date);
    if (!available) return { type: "sold_out" };

    // Provider is guaranteed to exist when isPaymentsEnabled() is true
    const provider = (await getActivePaymentProvider())!;

    const intent: RegistrationIntent = {
      eventId: event.id,
      ...contact,
      quantity,
      date,
      customUnitPrice,
    };

    const result = await provider.createCheckoutSession(event, intent, baseUrl);
    if (!result) return { type: "checkout_failed" };
    if ("error" in result)
      return { type: "checkout_failed", error: result.error };

    return { type: "checkout", checkoutUrl: result.checkoutUrl };
  }

  // Free event — create attendee atomically
  const result = await createAttendeeAtomic({
    eventId: event.id,
    ...contact,
    quantity,
    date,
  });

  if (!result.success)
    return { type: "creation_failed", reason: result.reason };

  await logAndNotifyRegistration(
    event,
    result.attendee,
    await getCurrencyCode(),
  );
  return { type: "success", attendee: result.attendee };
};
