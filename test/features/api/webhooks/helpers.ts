import type { Spy } from "@std/testing/mock";
import { stub } from "@std/testing/mock";
import { routePayment } from "#routes/api/webhooks.ts";
import type { ValidatedPaymentSession } from "#shared/payments.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { mockWebhookRequest } from "#test-utils/mocks.ts";

/** Call the payment router with path/method extracted from the request. */
export const routeRequest = (request: Request): Promise<Response | null> => {
  const url = new URL(request.url);
  return routePayment(request, url.pathname, request.method);
};

/** Webhook event id + type paired for stubWebhookVerify. */
export const checkoutEvent = (
  id: string,
  type = "checkout.session.completed",
) => ({
  data: { object: {} },
  id,
  type,
});

/** Send a signed webhook request and return the response. */
export const sendWebhook = () =>
  routeRequest(mockWebhookRequest({}, { "stripe-signature": "sig_valid" }));

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
) => {
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
    return (await sendWebhook()) as Response;
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
}) => {
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
