/**
 * Webhook routes - payment callbacks
 */

import {
  deleteAttendee,
  getAttendee,
  getEvent,
  updateAttendeePayment,
} from "#lib/db";
import { retrieveCheckoutSession } from "#lib/stripe.ts";
import type { Attendee, Event } from "#lib/types.ts";
import { notifyWebhook } from "#lib/webhook.ts";
import {
  paymentCancelPage,
  paymentErrorPage,
  paymentSuccessPage,
} from "#templates";
import { getSearchParam, htmlResponse } from "./utils.ts";

type PaymentCallbackData = { attendee: Attendee; event: Event };
type PaymentCallbackResult =
  | { success: true; data: PaymentCallbackData }
  | { success: false; response: Response };

/**
 * Load and validate attendee/event for payment callbacks
 */
const loadPaymentCallbackData = async (
  attendeeIdStr: string | null,
): Promise<PaymentCallbackResult> => {
  if (!attendeeIdStr) {
    return {
      success: false,
      response: htmlResponse(paymentErrorPage("Invalid payment callback"), 400),
    };
  }

  const attendee = await getAttendee(Number.parseInt(attendeeIdStr, 10));
  if (!attendee) {
    return {
      success: false,
      response: htmlResponse(paymentErrorPage("Attendee not found"), 404),
    };
  }

  const event = await getEvent(attendee.event_id);
  if (!event) {
    return {
      success: false,
      response: htmlResponse(paymentErrorPage("Event not found"), 404),
    };
  }

  return { success: true, data: { attendee, event } };
};

/**
 * Verify Stripe session and update payment
 */
const verifyAndUpdatePayment = async (
  sessionId: string,
  attendeeId: string,
  attendee: Attendee,
  event: Event,
): Promise<Response | null> => {
  const session = await retrieveCheckoutSession(sessionId);
  if (!session || session.payment_status !== "paid") {
    return htmlResponse(
      paymentErrorPage("Payment verification failed. Please contact support."),
      400,
    );
  }

  if (session.metadata?.attendee_id !== attendeeId) {
    return htmlResponse(
      paymentErrorPage("Payment session mismatch. Please contact support."),
      400,
    );
  }

  if (!attendee.stripe_payment_id) {
    await updateAttendeePayment(attendee.id, session.payment_intent as string);
    // Notify webhook for paid registrations (only on first confirmation)
    await notifyWebhook(event, attendee);
  }

  return htmlResponse(paymentSuccessPage(event, event.thank_you_url));
};

/**
 * Handle GET /payment/success (Stripe redirect after successful payment)
 */
const handlePaymentSuccess = async (request: Request): Promise<Response> => {
  const attendeeId = getSearchParam(request, "attendee_id");
  const sessionId = getSearchParam(request, "session_id");

  if (!sessionId) {
    return htmlResponse(paymentErrorPage("Invalid payment callback"), 400);
  }

  const result = await loadPaymentCallbackData(attendeeId);
  if (!result.success) return result.response;

  return (await verifyAndUpdatePayment(
    sessionId,
    attendeeId as string,
    result.data.attendee,
    result.data.event,
  )) as Response;
};

/**
 * Handle GET /payment/cancel (Stripe redirect after cancelled payment)
 */
const handlePaymentCancel = async (request: Request): Promise<Response> => {
  const result = await loadPaymentCallbackData(
    getSearchParam(request, "attendee_id"),
  );
  if (!result.success) return result.response;

  const { attendee, event } = result.data;
  await deleteAttendee(attendee.id);
  return htmlResponse(paymentCancelPage(event, `/ticket/${event.id}`));
};

/**
 * Route payment requests
 */
export const routePayment = async (
  request: Request,
  path: string,
  method: string,
): Promise<Response | null> => {
  if (method !== "GET") return null;

  if (path === "/payment/success") {
    return handlePaymentSuccess(request);
  }
  if (path === "/payment/cancel") {
    return handlePaymentCancel(request);
  }
  return null;
};
