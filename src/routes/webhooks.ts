/**
 * Webhook routes - payment callbacks
 */

import {
  deleteAttendee,
  getAttendee,
  updateAttendeePayment,
} from "#lib/db/attendees.ts";
import { getEvent } from "#lib/db/events.ts";
import { retrieveCheckoutSession } from "#lib/stripe.ts";
import type { Attendee, Event } from "#lib/types.ts";
import { notifyWebhook } from "#lib/webhook.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import {
  getSearchParam,
  htmlResponse,
  paymentErrorResponse,
} from "#routes/utils.ts";
import { paymentCancelPage, paymentSuccessPage } from "#templates/payment.tsx";

type PaymentParams = { attendeeId: string | null; sessionId: string | null };

/** Extract attendee_id and session_id from request search params */
const getPaymentParams = (request: Request): PaymentParams => ({
  attendeeId: getSearchParam(request, "attendee_id"),
  sessionId: getSearchParam(request, "session_id"),
});

/** Stripe checkout session type */
type CheckoutSession = Awaited<ReturnType<typeof retrieveCheckoutSession>>;

/** Verify session metadata matches attendee_id, return error response if mismatch */
const verifySessionAttendee =
  (attendeeId: string | null) =>
  (session: NonNullable<CheckoutSession>): Response | null =>
    session.metadata?.attendee_id !== attendeeId
      ? paymentErrorResponse(
          "Payment session mismatch. Please contact support.",
        )
      : null;

/** Retrieve session and verify it matches attendee, return error or session */
type SessionResult =
  | { session: NonNullable<CheckoutSession> }
  | { error: Response };

const retrieveAndVerifySession = async (
  sessionId: string,
  attendeeId: string | null,
  errorMessage: string,
): Promise<SessionResult> => {
  const session = await retrieveCheckoutSession(sessionId);
  if (!session) {
    return { error: paymentErrorResponse(errorMessage) };
  }
  const mismatchError = verifySessionAttendee(attendeeId)(session);
  if (mismatchError) return { error: mismatchError };
  return { session };
};

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
      response: paymentErrorResponse("Invalid payment callback"),
    };
  }

  const attendee = await getAttendee(Number.parseInt(attendeeIdStr, 10));
  if (!attendee) {
    return {
      success: false,
      response: paymentErrorResponse("Attendee not found", 404),
    };
  }

  const event = await getEvent(attendee.event_id);
  if (!event) {
    return {
      success: false,
      response: paymentErrorResponse("Event not found", 404),
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
    return paymentErrorResponse(
      "Payment verification failed. Please contact support.",
    );
  }

  const mismatchError = verifySessionAttendee(attendeeId)(session);
  if (mismatchError) return mismatchError;

  if (!attendee.stripe_payment_id) {
    await updateAttendeePayment(attendee.id, session.payment_intent as string);
    // Notify webhook for paid registrations (only on first confirmation)
    await notifyWebhook(event, attendee);
  }

  return htmlResponse(paymentSuccessPage(event, event.thank_you_url));
};

/** Context result type */
type PaymentContext =
  | { ok: true; params: PaymentParams; data: PaymentCallbackData }
  | { ok: false; response: Response };

/** Load payment callback data from request */
const loadPaymentContext = async (
  request: Request,
): Promise<PaymentContext> => {
  const params = getPaymentParams(request);
  const result = await loadPaymentCallbackData(params.attendeeId);
  return result.success
    ? { ok: true, params, data: result.data }
    : { ok: false, response: result.response };
};

/** Error response for missing session_id */
const missingSessionError = (): Response =>
  paymentErrorResponse("Invalid payment callback");

/** Precheck: require session_id */
const requireSessionId = (params: PaymentParams): Response | null =>
  params.sessionId ? null : missingSessionError();

/** Type for handler function */
type PaymentHandler = (
  params: PaymentParams,
  data: PaymentCallbackData,
) => Promise<Response>;

/** Run optional precheck, return error or null */
const runPrecheck = (
  precheck: ((params: PaymentParams) => Response | null) | null,
  params: PaymentParams,
): Response | null => (precheck ? precheck(params) : null);

/** Create payment callback handler with optional precheck */
const createPaymentHandler =
  (precheck: ((params: PaymentParams) => Response | null) | null) =>
  (handler: PaymentHandler) =>
  async (request: Request): Promise<Response> => {
    const params = getPaymentParams(request);
    const precheckError = runPrecheck(precheck, params);
    if (precheckError) return precheckError;
    const ctx = await loadPaymentContext(request);
    return ctx.ok ? handler(ctx.params, ctx.data) : ctx.response;
  };

/**
 * Handle GET /payment/success (Stripe redirect after successful payment)
 */
const handlePaymentSuccess = createPaymentHandler(requireSessionId)(
  async (params, { attendee, event }) =>
    (await verifyAndUpdatePayment(
      params.sessionId as string,
      params.attendeeId as string,
      attendee,
      event,
    )) as Response,
);

/**
 * Verify Stripe session matches attendee for cancellation
 * Returns error response if verification fails, null if successful
 */
const verifyCancelSession = async (
  sessionId: string | null,
  attendeeId: string | null,
  attendee: Attendee,
): Promise<Response | null> => {
  if (!sessionId) {
    return paymentErrorResponse("Invalid payment callback");
  }

  const result = await retrieveAndVerifySession(
    sessionId,
    attendeeId,
    "Payment session not found. Please contact support.",
  );
  if ("error" in result) return result.error;

  // Only allow cancellation of unpaid attendees
  if (attendee.stripe_payment_id) {
    return paymentErrorResponse("Cannot cancel a completed payment.");
  }

  return null;
};

/**
 * Handle GET /payment/cancel (Stripe redirect after cancelled payment)
 */
const handlePaymentCancel = createPaymentHandler(null)(
  async (params, { attendee, event }) => {
    const cancelError = await verifyCancelSession(
      params.sessionId,
      params.attendeeId,
      attendee,
    );
    if (cancelError) return cancelError;

    await deleteAttendee(attendee.id);
    return htmlResponse(paymentCancelPage(event, `/ticket/${event.id}`));
  },
);

/** Payment routes definition */
const paymentRoutes = defineRoutes({
  "GET /payment/success/": (request) => handlePaymentSuccess(request),
  "GET /payment/cancel/": (request) => handlePaymentCancel(request),
});

/**
 * Route payment requests
 */
export const routePayment = createRouter(paymentRoutes);
