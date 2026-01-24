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

/** Run operation with stripe client, return null if not available */
const withClient = async <T>(
  op: (client: Stripe) => Promise<T>,
): Promise<T | null> => {
  const client = await getClientImpl();
  return client ? safeAsync(() => op(client)) : null;
};

/** Internal getStripeClient implementation */
const getClientImpl = async (): Promise<Stripe | null> => {
  const secretKey = getStripeSecretKey();
  if (!secretKey) return null;

  try {
    const cached = getCache();
    if (cached.secretKey === secretKey) return cached.client;
  } catch {
    // Cache not initialized
  }

  const client = await createStripeClient(secretKey);
  setCache({ client, secretKey });
  return client;
};

/** Build checkout session params */
type SessionConfig = {
  event: Event;
  quantity: number;
  email: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
};

const buildSessionParams = async (
  cfg: SessionConfig,
): Promise<Stripe.Checkout.SessionCreateParams | null> => {
  if (cfg.event.unit_price === null) return null;
  const currency = (await getCurrencyCode()).toLowerCase();
  const label = cfg.quantity > 1 ? `${cfg.quantity} Tickets` : "Ticket";
  return {
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency,
          product_data: {
            name: cfg.event.name,
            description: `${label} for ${cfg.event.name}`,
          },
          unit_amount: cfg.event.unit_price,
        },
        quantity: cfg.quantity,
      },
    ],
    mode: "payment",
    success_url: cfg.successUrl,
    cancel_url: cfg.cancelUrl,
    customer_email: cfg.email,
    metadata: cfg.metadata,
  };
};

/**
 * Stubbable API for testing - allows mocking in ES modules
 * Production code uses stripeApi.method() to enable test mocking
 */
export const stripeApi = {
  /** Get or create Stripe client */
  getStripeClient: getClientImpl,

  /** Reset Stripe client (for testing) */
  resetStripeClient: (): void => setCache(null),

  /** Create checkout session for ticket purchase */
  createCheckoutSession: async (
    evt: Event,
    attendee: Attendee,
    base: string,
    qty = 1,
  ): Promise<Stripe.Checkout.Session | null> => {
    const attendeeQuery = `attendee_id=${attendee.id}&session_id={CHECKOUT_SESSION_ID}`;
    const sessionParams = await buildSessionParams({
      event: evt,
      quantity: qty,
      email: attendee.email,
      successUrl: `${base}/payment/success?${attendeeQuery}`,
      cancelUrl: `${base}/payment/cancel?${attendeeQuery}`,
      metadata: {
        attendee_id: String(attendee.id),
        event_id: String(evt.id),
        quantity: String(qty),
      },
    });
    if (!sessionParams) return null;
    return withClient((s) => s.checkout.sessions.create(sessionParams));
  },

  /** Retrieve checkout session */
  retrieveCheckoutSession: (id: string): Promise<Stripe.Checkout.Session | null> =>
    withClient((s) => s.checkout.sessions.retrieve(id)),

  /** Refund a payment */
  refundPayment: (intentId: string): Promise<Stripe.Refund | null> =>
    withClient((s) => s.refunds.create({ payment_intent: intentId })),

  /** Create checkout session with intent (deferred attendee creation) */
  createCheckoutSessionWithIntent: async (
    event: Event,
    intent: RegistrationIntent,
    baseUrl: string,
  ): Promise<Stripe.Checkout.Session | null> => {
    const config = await buildSessionParams({
      event,
      quantity: intent.quantity,
      email: intent.email,
      successUrl: `${baseUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${baseUrl}/payment/cancel?session_id={CHECKOUT_SESSION_ID}`,
      metadata: {
        event_id: String(event.id),
        name: intent.name,
        email: intent.email,
        quantity: String(intent.quantity),
      },
    });
    return config ? withClient((stripe) => stripe.checkout.sessions.create(config)) : null;
  },
};

/** Registration intent stored in Stripe session metadata */
export type RegistrationIntent = {
  eventId: number;
  name: string;
  email: string;
  quantity: number;
};

// Wrapper functions that delegate to stripeApi at runtime (enables test mocking)
export const getStripeClient = () => stripeApi.getStripeClient();
export const resetStripeClient = () => stripeApi.resetStripeClient();
export const retrieveCheckoutSession = (id: string) =>
  stripeApi.retrieveCheckoutSession(id);
export const refundPayment = (id: string) => stripeApi.refundPayment(id);
export const createCheckoutSession = (
  e: Event,
  a: Attendee,
  b: string,
  q?: number,
) => stripeApi.createCheckoutSession(e, a, b, q);
export const createCheckoutSessionWithIntent = (
  e: Event,
  i: RegistrationIntent,
  b: string,
) => stripeApi.createCheckoutSessionWithIntent(e, i, b);
