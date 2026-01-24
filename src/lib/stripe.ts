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

/** Execute operation with Stripe client, returning null if unavailable */
const withStripe = async <T>(
  fn: (stripe: Stripe) => Promise<T>,
): Promise<T | null> => {
  const stripe = await getStripeClient();
  if (!stripe) return null;
  return safeAsync(() => fn(stripe));
};

/**
 * Get Stripe client configuration for mock server (if configured)
 */
const getMockConfig = once((): Stripe.StripeConfig | undefined => {
  const mockHost = process.env.STRIPE_MOCK_HOST;
  if (!mockHost) return undefined;

  const mockPort = Number.parseInt(process.env.STRIPE_MOCK_PORT || "12111", 10);
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
 * Get or create Stripe client
 * Returns null if Stripe secret key is not set
 * Supports stripe-mock via STRIPE_MOCK_HOST env var
 */
export const getStripeClient = async (): Promise<Stripe | null> => {
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
};

/**
 * Reset Stripe client (for testing)
 */
export const resetStripeClient = (): void => {
  setCache(null);
};

/** Checkout session config */
type CheckoutConfig = {
  successUrl: string;
  cancelUrl: string;
  customerEmail: string;
  quantity: number;
  metadata: Record<string, string>;
};

/** Build payment callback URL with session ID placeholder */
const callbackUrl = (base: string, path: string, extra = ""): string =>
  `${base}/payment/${path}?${extra}session_id={CHECKOUT_SESSION_ID}`;

/** Build line items for checkout session */
const buildLineItems = (
  event: Event,
  quantity: number,
  currency: string,
): Stripe.Checkout.SessionCreateParams["line_items"] => {
  const ticketLabel = quantity > 1 ? `${quantity} Tickets` : "Ticket";
  return [
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
  ];
};

/** Create checkout session with config */
const createSession = async (
  event: Event,
  config: CheckoutConfig,
): Promise<Stripe.Checkout.Session | null> => {
  const stripe = await getStripeClient();
  if (!stripe || event.unit_price === null) return null;

  const currency = (await getCurrencyCode()).toLowerCase();
  return safeAsync(() =>
    stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: buildLineItems(event, config.quantity, currency),
      mode: "payment",
      success_url: config.successUrl,
      cancel_url: config.cancelUrl,
      customer_email: config.customerEmail,
      metadata: config.metadata,
    }),
  );
};

/**
 * Create a Stripe Checkout session for a ticket purchase (legacy)
 */
export const createCheckoutSession = (
  event: Event,
  attendee: Attendee,
  baseUrl: string,
  quantity = 1,
): Promise<Stripe.Checkout.Session | null> => {
  const attendeeParam = `attendee_id=${attendee.id}&`;
  return createSession(event, {
    successUrl: callbackUrl(baseUrl, "success", attendeeParam),
    cancelUrl: callbackUrl(baseUrl, "cancel", attendeeParam),
    customerEmail: attendee.email,
    quantity,
    metadata: {
      attendee_id: String(attendee.id),
      event_id: String(event.id),
      quantity: String(quantity),
    },
  });
};

/**
 * Retrieve a Stripe Checkout session
 */
export const retrieveCheckoutSession = async (
  sessionId: string,
): Promise<Stripe.Checkout.Session | null> =>
  withStripe((stripe) => stripe.checkout.sessions.retrieve(sessionId));

/**
 * Refund a payment by payment intent ID
 * Used when atomic attendee creation fails after payment
 */
export const refundPayment = async (
  paymentIntentId: string,
): Promise<Stripe.Refund | null> =>
  withStripe((stripe) =>
    stripe.refunds.create({ payment_intent: paymentIntentId }),
  );

/** Registration intent stored in Stripe session metadata */
export type RegistrationIntent = {
  eventId: number;
  name: string;
  email: string;
  quantity: number;
};

/**
 * Create a Stripe Checkout session for ticket purchase intent.
 * Stores registration details in metadata - attendee created after payment.
 * This prevents race conditions by deferring attendee creation to payment confirmation.
 */
export const createCheckoutSessionWithIntent = (
  event: Event,
  intent: RegistrationIntent,
  baseUrl: string,
): Promise<Stripe.Checkout.Session | null> => {
  const { eventId, name, email, quantity } = { ...intent, eventId: event.id };
  return createSession(event, {
    successUrl: callbackUrl(baseUrl, "success"),
    cancelUrl: callbackUrl(baseUrl, "cancel"),
    customerEmail: email,
    quantity,
    metadata: {
      event_id: String(eventId),
      name,
      email,
      quantity: String(quantity),
    },
  });
};
