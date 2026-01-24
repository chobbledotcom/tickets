/**
 * Stripe integration module for ticket payments
 * Uses lazy loading to avoid importing the Stripe SDK at startup
 */

import type Stripe from "stripe";
import { lazyRef, once } from "#fp";
import { getCurrencyCode, getStripeSecretKey } from "#lib/config.ts";
import type { Attendee, Event } from "#lib/types.ts";

/** Lazy-load Stripe SDK only when needed */
const loadStripe = once(async () => {
  const { default: Stripe } = await import("stripe");
  return Stripe;
});

type StripeCache = { client: Stripe; secretKey: string };

/** Safely execute async operation, returning null on error */
const safeAsync = async <T>(fn: () => Promise<T>): Promise<T | null> => {
  try {
    return await fn();
  } catch {
    return null;
  }
};

/**
 * Get Stripe client configuration for mock server (if configured)
 */
const getMockConfig = once((): Stripe.StripeConfig | undefined => {
  const mockHost = Deno.env.get("STRIPE_MOCK_HOST");
  if (!mockHost) return undefined;

  const mockPort = Number.parseInt(
    Deno.env.get("STRIPE_MOCK_PORT") || "12111",
    10,
  );
  return {
    host: mockHost,
    port: mockPort,
    protocol: "http",
  };
});

const createStripeClient = async (secretKey: string): Promise<Stripe> => {
  const mockConfig = getMockConfig();
  const StripeClass = await loadStripe();
  return mockConfig
    ? new StripeClass(secretKey, mockConfig)
    : new StripeClass(secretKey);
};

const [getCache, setCache] = lazyRef<StripeCache>(() => {
  throw new Error("Stripe cache not initialized");
});

/**
 * Stubbable API for testing - allows mocking in ES modules
 * Production code uses stripeApi.method() to enable test mocking
 */
export const stripeApi = {
  /**
   * Get or create Stripe client
   * Returns null if Stripe secret key is not set
   * Supports stripe-mock via STRIPE_MOCK_HOST env var
   */
  getStripeClient: async (): Promise<Stripe | null> => {
    const secretKey = getStripeSecretKey();
    if (!secretKey) return null;

    // Re-create client if secret key changed
    try {
      const cached = getCache();
      if (cached.secretKey === secretKey) {
        return cached.client;
      }
    } catch {
      // Cache not initialized yet
    }

    const client = await createStripeClient(secretKey);
    setCache({ client, secretKey });
    return client;
  },

  /**
   * Reset Stripe client (for testing)
   */
  resetStripeClient: (): void => {
    setCache(null);
  },

  /**
   * Create a Stripe Checkout session for a ticket purchase
   */
  createCheckoutSession: async (
    event: Event,
    attendee: Attendee,
    baseUrl: string,
    quantity = 1,
  ): Promise<Stripe.Checkout.Session | null> => {
    const stripe = await stripeApi.getStripeClient();
    if (!stripe || event.unit_price === null) return null;

    const currency = (await getCurrencyCode()).toLowerCase();
    const successUrl = `${baseUrl}/payment/success?attendee_id=${attendee.id}&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${baseUrl}/payment/cancel?attendee_id=${attendee.id}&session_id={CHECKOUT_SESSION_ID}`;
    const ticketLabel = quantity > 1 ? `${quantity} Tickets` : "Ticket";

    return safeAsync(() =>
      stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency,
              product_data: {
                name: event.name,
                description: `${ticketLabel} for ${event.name}`,
              },
              unit_amount: event.unit_price as number,
            },
            quantity,
          },
        ],
        mode: "payment",
        success_url: successUrl,
        cancel_url: cancelUrl,
        customer_email: attendee.email,
        metadata: {
          attendee_id: String(attendee.id),
          event_id: String(event.id),
          quantity: String(quantity),
        },
      })
    );
  },

  /**
   * Retrieve a Stripe Checkout session
   */
  retrieveCheckoutSession: async (
    sessionId: string,
  ): Promise<Stripe.Checkout.Session | null> => {
    const client = await stripeApi.getStripeClient();
    return client
      ? safeAsync(() => client.checkout.sessions.retrieve(sessionId))
      : null;
  },

  /**
   * Refund a payment by payment intent ID
   * Used when atomic attendee creation fails after payment
   */
  refundPayment: async (
    paymentIntentId: string,
  ): Promise<Stripe.Refund | null> => {
    const client = await stripeApi.getStripeClient();
    return client
      ? safeAsync(() => client.refunds.create({ payment_intent: paymentIntentId }))
      : null;
  },

  /**
   * Create a Stripe Checkout session for ticket purchase intent.
   * Stores registration details in metadata - attendee created after payment.
   * This prevents race conditions by deferring attendee creation to payment confirmation.
   */
  createCheckoutSessionWithIntent: async (
    event: Event,
    intent: RegistrationIntent,
    baseUrl: string,
  ): Promise<Stripe.Checkout.Session | null> => {
    const stripe = await stripeApi.getStripeClient();
    if (!stripe || event.unit_price === null) return null;

    const currency = (await getCurrencyCode()).toLowerCase();
    const successUrl = `${baseUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${baseUrl}/payment/cancel?session_id={CHECKOUT_SESSION_ID}`;
    const ticketLabel = intent.quantity > 1 ? `${intent.quantity} Tickets` : "Ticket";

    return safeAsync(() =>
      stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency,
              product_data: {
                name: event.name,
                description: `${ticketLabel} for ${event.name}`,
              },
              unit_amount: event.unit_price as number,
            },
            quantity: intent.quantity,
          },
        ],
        mode: "payment",
        success_url: successUrl,
        cancel_url: cancelUrl,
        customer_email: intent.email,
        metadata: {
          event_id: String(event.id),
          name: intent.name,
          email: intent.email,
          quantity: String(intent.quantity),
        },
      }),
    );
  },
};

/** Registration intent stored in Stripe session metadata */
export type RegistrationIntent = {
  eventId: number;
  name: string;
  email: string;
  quantity: number;
};

// Re-export as wrapper functions so mocking stripeApi works
// These delegate to stripeApi at call time, enabling test mocks
export const getStripeClient = (): Promise<Stripe | null> =>
  stripeApi.getStripeClient();

export const resetStripeClient = (): void => stripeApi.resetStripeClient();

export const createCheckoutSession = (
  event: Event,
  attendee: Attendee,
  baseUrl: string,
  quantity?: number,
): Promise<Stripe.Checkout.Session | null> =>
  stripeApi.createCheckoutSession(event, attendee, baseUrl, quantity);

export const retrieveCheckoutSession = (
  sessionId: string,
): Promise<Stripe.Checkout.Session | null> =>
  stripeApi.retrieveCheckoutSession(sessionId);

export const refundPayment = (
  paymentIntentId: string,
): Promise<Stripe.Refund | null> =>
  stripeApi.refundPayment(paymentIntentId);

export const createCheckoutSessionWithIntent = (
  event: Event,
  intent: RegistrationIntent,
  baseUrl: string,
): Promise<Stripe.Checkout.Session | null> =>
  stripeApi.createCheckoutSessionWithIntent(event, intent, baseUrl);
