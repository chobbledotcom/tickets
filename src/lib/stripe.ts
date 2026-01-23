/**
 * Stripe integration module for ticket payments
 */

import Stripe from "stripe";
import { lazyRef, once } from "#fp";
import { getCurrencyCode, getStripeSecretKey } from "./config.ts";
import type { Attendee, Event } from "./types.ts";

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

const createStripeClient = (secretKey: string): Stripe => {
  const mockConfig = getMockConfig();
  return mockConfig ? new Stripe(secretKey, mockConfig) : new Stripe(secretKey);
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
  const secretKey = await getStripeSecretKey();
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

  const client = createStripeClient(secretKey);
  setCache({ client, secretKey });
  return client;
};

/**
 * Reset Stripe client (for testing)
 */
export const resetStripeClient = (): void => {
  setCache(null);
};

/**
 * Create a Stripe Checkout session for a ticket purchase
 */
export const createCheckoutSession = async (
  event: Event,
  attendee: Attendee,
  baseUrl: string,
): Promise<Stripe.Checkout.Session | null> => {
  const stripe = await getStripeClient();
  if (!stripe || event.unit_price === null) return null;

  const currency = (await getCurrencyCode()).toLowerCase();
  const successUrl = `${baseUrl}/payment/success?attendee_id=${attendee.id}&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${baseUrl}/payment/cancel?attendee_id=${attendee.id}`;

  return safeAsync(() =>
    stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency,
            product_data: {
              name: event.name,
              description: `Ticket for ${event.name}`,
            },
            unit_amount: event.unit_price as number,
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: attendee.email,
      metadata: {
        attendee_id: String(attendee.id),
        event_id: String(event.id),
      },
    }),
  );
};

/**
 * Retrieve a Stripe Checkout session
 */
export const retrieveCheckoutSession = async (
  sessionId: string,
): Promise<Stripe.Checkout.Session | null> =>
  withStripe((stripe) => stripe.checkout.sessions.retrieve(sessionId));

/**
 * Verify a Stripe webhook signature
 */
export const verifyWebhookSignature = async (
  payload: string,
  signature: string,
  webhookSecret: string,
): Promise<Stripe.Event | null> => {
  const stripe = await getStripeClient();
  if (!stripe) return null;
  return safeAsync(async () =>
    stripe.webhooks.constructEvent(payload, signature, webhookSecret),
  );
};

/**
 * Format price for display (converts from smallest currency unit)
 */
export const formatPrice = async (amount: number): Promise<string> => {
  const currency = await getCurrencyCode();
  const formatter = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
  });
  return formatter.format(amount / 100);
};
