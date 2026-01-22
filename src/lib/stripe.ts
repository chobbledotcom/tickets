/**
 * Stripe integration module for ticket payments
 */

import Stripe from "stripe";
import { getCurrencyCode, getStripeSecretKey } from "./config.ts";
import type { Attendee, Event } from "./types.ts";

let stripeClient: Stripe | null = null;
let cachedSecretKey: string | null = null;

/**
 * Get Stripe client configuration for mock server (if configured)
 */
const getMockConfig = (): Stripe.StripeConfig | undefined => {
  const mockHost = process.env.STRIPE_MOCK_HOST;
  if (!mockHost) return undefined;

  const mockPort = Number.parseInt(process.env.STRIPE_MOCK_PORT || "12111", 10);
  return {
    host: mockHost,
    port: mockPort,
    protocol: "http",
  };
};

/**
 * Get or create Stripe client
 * Returns null if Stripe secret key is not set
 * Supports stripe-mock via STRIPE_MOCK_HOST env var
 */
export const getStripeClient = async (): Promise<Stripe | null> => {
  const secretKey = await getStripeSecretKey();
  if (!secretKey) return null;

  // Re-create client if secret key changed
  if (!stripeClient || cachedSecretKey !== secretKey) {
    const mockConfig = getMockConfig();
    stripeClient = mockConfig
      ? new Stripe(secretKey, mockConfig)
      : new Stripe(secretKey);
    cachedSecretKey = secretKey;
  }
  return stripeClient;
};

/**
 * Reset Stripe client (for testing)
 */
export const resetStripeClient = (): void => {
  stripeClient = null;
  cachedSecretKey = null;
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

  try {
    const currency = (await getCurrencyCode()).toLowerCase();
    const successUrl = `${baseUrl}/payment/success?attendee_id=${attendee.id}&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${baseUrl}/payment/cancel?attendee_id=${attendee.id}`;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency,
            product_data: {
              name: event.name,
              description: `Ticket for ${event.name}`,
            },
            unit_amount: event.unit_price,
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
    });

    return session;
  } catch {
    return null;
  }
};

/**
 * Retrieve a Stripe Checkout session
 */
export const retrieveCheckoutSession = async (
  sessionId: string,
): Promise<Stripe.Checkout.Session | null> => {
  const stripe = await getStripeClient();
  if (!stripe) return null;

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    return session;
  } catch {
    return null;
  }
};

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

  try {
    return stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  } catch {
    return null;
  }
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
