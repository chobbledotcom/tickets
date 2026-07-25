import { expect } from "@std/expect";
import type { Spy } from "@std/testing/mock";
import { stub } from "@std/testing/mock";
import { routePayment } from "#routes/api/webhooks.ts";
import type {
  ValidatedPaymentSession,
  WebhookEvent,
} from "#shared/payments.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { mockWebhookRequest } from "#test-utils/mocks.ts";

/** Call the payment router and fail loudly when the request matches no route. */
export const routedResponse = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const response = await routePayment(request, url.pathname, request.method);
  if (response === null) {
    throw new Error(
      `No payment route matched ${request.method} ${url.pathname}`,
    );
  }
  return response;
};

/** Webhook event id + type paired for stubWebhookVerify. */
export const checkoutEvent = (
  id: string,
  type = "checkout.session.completed",
): WebhookEvent => ({
  data: { object: {} },
  id,
  type,
});

/** Send a signed webhook request and return the response. */
export const sendWebhook = (): Promise<Response> =>
  routedResponse(mockWebhookRequest({}, { "stripe-signature": "sig_valid" }));

/** Assert an HTTP status and body substring. */
export const expectResponseWithText = async (
  response: Response,
  status: number,
  text: string,
): Promise<void> => {
  expect(response.status).toBe(status);
  expect(await response.text()).toContain(text);
};

/** Assert an error response and its matching logged error. */
export const expectLoggedErrorResponse = async (
  response: Response,
  status: number,
  text: string,
  loggedText: string,
  errorContains: (message: string) => boolean,
): Promise<void> => {
  await expectResponseWithText(response, status, text);
  expect(errorContains(loggedText)).toBe(true);
};

/** Restore all stubs in reverse order (like a finally block). */
export const restoreAll = (...stubs: Spy[]): void => {
  for (const s of stubs.reverse()) s.restore();
};

/** Create a listing and fill it to capacity so a subsequent booking fails. */
export const createSoldOutListing = async (
  unitPrice = 1000,
): ReturnType<typeof createTestListing> => {
  const listing = await createTestListing({ maxAttendees: 1, unitPrice });
  const { createTestAttendeeDirect } = await import(
    "#test-utils/db-helpers/attendees.ts"
  );
  await createTestAttendeeDirect(listing.id, "First", "first@example.com", 1);
  return listing;
};

/** Stub stripeApi.retrieveCheckoutSession to return a session with the given
 * id, payment intent, metadata fields, and amount. Returns the stub to
 * restore in a finally block. */
export const stubRetrieveSession = async (
  sessionId: string,
  paymentIntent: string,
  listing: { id: number },
  unitPrice: number,
  extraMeta: Record<string, string> = {},
): Promise<Spy> => {
  const { stripeApi } = await import("#shared/stripe.ts");
  return stub(stripeApi, "retrieveCheckoutSession", () =>
    Promise.resolve({
      amount_total: unitPrice,
      id: sessionId,
      metadata: signedMeta(
        {
          email: "john@example.com",
          items: singleItem(listing.id, 1, unitPrice),
          name: "John",
          ...extraMeta,
        },
        unitPrice,
      ),
      payment_intent: paymentIntent,
      payment_status: "paid",
    } as unknown as Awaited<
      ReturnType<typeof stripeApi.retrieveCheckoutSession>
    >),
  );
};

/** Set up a Stripe webhook test: resolve stub + verify stub, return the
 * webhook response, and restore both stubs afterwards. */
export const stripeWebhookResponse = async (
  resolve: Spy,
  eventId: string,
  eventType = "checkout.session.completed",
): Promise<Response> => {
  const { stubWebhookVerify } = await import("#test-utils/settings.ts");
  const verify = await stubWebhookVerify(checkoutEvent(eventId, eventType));
  try {
    return await sendWebhook();
  } finally {
    restoreAll(verify, resolve);
  }
};

/** Stub resolveWebhookSession to return a signed paid session for a listing.
 * Many webhook resolution tests need the same signed metadata + session shape,
 * so currying it here keeps the (structurally identical) block defined once. */
export const stubPaidSession = (opts: {
  id: string;
  listing: { id: number };
  paymentIntent: string;
  paymentStatus?: string;
  unitPrice?: number;
}): Spy => {
  const amount = opts.unitPrice ?? 1000;
  return stub(stripePaymentProvider, "resolveWebhookSession", () =>
    Promise.resolve({
      amountTotal: amount,
      id: opts.id,
      metadata: signedMeta(
        {
          email: "john@example.com",
          items: singleItem(opts.listing.id, 1, amount),
          name: "John",
        },
        amount,
      ),
      paymentReference: opts.paymentIntent,
      paymentStatus: (opts.paymentStatus ??
        "paid") as ValidatedPaymentSession["paymentStatus"],
    } as ValidatedPaymentSession),
  );
};

/** Make both provider refund checks report that no refund completed. */
export const stubFailedRefund = (): Spy[] => [
  stub(stripePaymentProvider, "refundPayment", () => Promise.resolve(false)),
  stub(stripePaymentProvider, "isPaymentRefunded", () =>
    Promise.resolve(false),
  ),
];
