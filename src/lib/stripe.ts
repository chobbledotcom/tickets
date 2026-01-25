/**
 * Stripe integration module for ticket payments
 * Uses lazy loading to avoid importing the Stripe SDK at startup
 */

import type Stripe from "stripe";
import { lazyRef, once } from "#fp";
import {
  getCurrencyCode,
  getStripeSecretKey,
  getStripeWebhookSecret,
} from "#lib/config.ts";
import { ErrorCode, type ErrorCodeType, logError } from "#lib/logger.ts";
import type { Event } from "#lib/types.ts";

/** Lazy-load Stripe SDK only when needed */
const loadStripe = once(async () => {
  const { default: Stripe } = await import("stripe");
  return Stripe;
});

type StripeCache = { client: Stripe; secretKey: string };

/** Safely execute async operation, returning null on error */
const safeAsync = async <T>(
  fn: () => Promise<T>,
  errorCode: ErrorCodeType,
): Promise<T | null> => {
  try {
    return await fn();
  } catch {
    logError({ code: errorCode });
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
  errorCode: ErrorCodeType,
): Promise<T | null> => {
  const client = await getClientImpl();
  return client ? safeAsync(() => op(client), errorCode) : null;
};

/** Internal getStripeClient implementation */
const getClientImpl = async (): Promise<Stripe | null> => {
  const secretKey = await getStripeSecretKey();
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
            name: `Ticket: ${cfg.event.slug}`,
            description: label,
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

/** Result of webhook endpoint setup */
export type WebhookSetupResult =
  | { success: true; endpointId: string; secret: string }
  | { success: false; error: string };

/**
 * Stubbable API for testing - allows mocking in ES modules
 * Production code uses stripeApi.method() to enable test mocking
 */
export const stripeApi: {
  getStripeClient: () => Promise<Stripe | null>;
  resetStripeClient: () => void;
  retrieveCheckoutSession: (id: string) => Promise<Stripe.Checkout.Session | null>;
  refundPayment: (intentId: string) => Promise<Stripe.Refund | null>;
  createCheckoutSessionWithIntent: (
    event: Event,
    intent: RegistrationIntent,
    baseUrl: string,
  ) => Promise<Stripe.Checkout.Session | null>;
  setupWebhookEndpoint: (
    secretKey: string,
    webhookUrl: string,
    existingEndpointId?: string | null,
  ) => Promise<WebhookSetupResult>;
} = {
  /** Get or create Stripe client */
  getStripeClient: getClientImpl,

  /** Reset Stripe client (for testing) */
  resetStripeClient: (): void => setCache(null),

  /** Retrieve checkout session */
  retrieveCheckoutSession: (
    id: string,
  ): Promise<Stripe.Checkout.Session | null> =>
    withClient((s) => s.checkout.sessions.retrieve(id), ErrorCode.STRIPE_SESSION),

  /** Refund a payment */
  refundPayment: (intentId: string): Promise<Stripe.Refund | null> =>
    withClient(
      (s) => s.refunds.create({ payment_intent: intentId }),
      ErrorCode.STRIPE_REFUND,
    ),

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
    return config
      ? withClient(
          (stripe) => stripe.checkout.sessions.create(config),
          ErrorCode.STRIPE_CHECKOUT,
        )
      : null;
  },

  // Placeholder - will be set after setupWebhookEndpointImpl is defined
  setupWebhookEndpoint: null as unknown as (
    secretKey: string,
    webhookUrl: string,
    existingEndpointId?: string | null,
  ) => Promise<WebhookSetupResult>,
};

/** Registration intent stored in Stripe session metadata */
export type RegistrationIntent = {
  eventId: number;
  name: string;
  email: string;
  quantity: number;
};

/**
 * Internal implementation of webhook endpoint setup.
 * Use setupWebhookEndpoint export for production code.
 */
const setupWebhookEndpointImpl = async (
  secretKey: string,
  webhookUrl: string,
  existingEndpointId?: string | null,
): Promise<WebhookSetupResult> => {
  try {
    const client = await createStripeClient(secretKey);

    // If we have an existing endpoint ID, try to delete it so we can recreate
    // (update doesn't return the secret, so we need to recreate to get a fresh one)
    if (existingEndpointId) {
      try {
        await client.webhookEndpoints.del(existingEndpointId);
      } catch {
        // Endpoint doesn't exist or can't be deleted, will create new one
      }
    }

    // Check if a webhook already exists for this exact URL
    const existingEndpoints = await client.webhookEndpoints.list({ limit: 100 });
    const existingForUrl = existingEndpoints.data.find(
      (ep) => ep.url === webhookUrl,
    );

    if (existingForUrl) {
      // Delete existing endpoint to recreate with fresh secret
      await client.webhookEndpoints.del(existingForUrl.id);
    }

    // Create new webhook endpoint
    const endpoint = await client.webhookEndpoints.create({
      url: webhookUrl,
      enabled_events: ["checkout.session.completed"],
    });

    if (!endpoint.secret) {
      return { success: false, error: "Stripe did not return webhook secret" };
    }

    return {
      success: true,
      endpointId: endpoint.id,
      secret: endpoint.secret,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logError({ code: ErrorCode.STRIPE_WEBHOOK_SETUP, detail: message });
    return { success: false, error: message };
  }
};

// Add setupWebhookEndpoint to stripeApi for testability
stripeApi.setupWebhookEndpoint = setupWebhookEndpointImpl;

/**
 * Create or update a webhook endpoint for the given URL.
 * If an endpoint already exists for this URL, updates it.
 * Returns the webhook secret for signature verification.
 *
 * @param secretKey - Stripe secret key to use (passed directly since this runs before key is stored)
 * @param webhookUrl - Full URL for the webhook endpoint
 * @param existingEndpointId - Optional existing endpoint ID to update
 */
export const setupWebhookEndpoint = (
  secretKey: string,
  webhookUrl: string,
  existingEndpointId?: string | null,
): Promise<WebhookSetupResult> =>
  stripeApi.setupWebhookEndpoint(secretKey, webhookUrl, existingEndpointId);

// Wrapper functions that delegate to stripeApi at runtime (enables test mocking)
export const getStripeClient = () => stripeApi.getStripeClient();
export const resetStripeClient = () => stripeApi.resetStripeClient();
export const retrieveCheckoutSession = (id: string) =>
  stripeApi.retrieveCheckoutSession(id);
export const refundPayment = (id: string) => stripeApi.refundPayment(id);
export const createCheckoutSessionWithIntent = (
  e: Event,
  i: RegistrationIntent,
  b: string,
) => stripeApi.createCheckoutSessionWithIntent(e, i, b);

/**
 * =============================================================================
 * Webhook Signature Verification (Web Crypto API for Edge compatibility)
 * =============================================================================
 * Implements Stripe webhook signature verification without the Stripe SDK.
 * Uses HMAC-SHA256 via Web Crypto API for Bunny Edge Scripts compatibility.
 */

/** Default timestamp tolerance: 5 minutes (300 seconds) */
const DEFAULT_TOLERANCE_SECONDS = 300;

/** Parse Stripe signature header into components */
const parseSignatureHeader = (
  header: string,
): { timestamp: number; signatures: string[] } | null => {
  const parts = header.split(",");
  let timestamp = 0;
  const signatures: string[] = [];

  for (const part of parts) {
    const [key, value] = part.split("=");
    if (key === "t") {
      timestamp = Number.parseInt(value ?? "0", 10);
    } else if (key === "v1" && value) {
      signatures.push(value);
    }
  }

  if (timestamp === 0 || signatures.length === 0) {
    return null;
  }

  return { timestamp, signatures };
};

/** Compute HMAC-SHA256 signature using Web Crypto API */
const computeSignature = async (
  payload: string,
  secret: string,
): Promise<string> => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  );
  // Convert to hex string
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

/** Constant-time string comparison to prevent timing attacks */
const secureCompare = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
};

/** Webhook verification result */
export type WebhookVerifyResult =
  | { valid: true; event: StripeWebhookEvent }
  | { valid: false; error: string };

/** Stripe webhook event structure (subset we care about) */
export type StripeWebhookEvent = {
  id: string;
  type: string;
  data: {
    object: Record<string, unknown>;
  };
};

/**
 * Verify Stripe webhook signature using Web Crypto API.
 * Compatible with edge runtimes (Bunny Edge Scripts, Cloudflare Workers, Deno Deploy).
 *
 * @param payload - Raw request body as string
 * @param signature - Stripe-Signature header value
 * @param toleranceSeconds - Max age of event in seconds (default: 300)
 */
export const verifyWebhookSignature = async (
  payload: string,
  signature: string,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): Promise<WebhookVerifyResult> => {
  const secret = await getStripeWebhookSecret();
  if (!secret) {
    logError({ code: ErrorCode.CONFIG_MISSING, detail: "webhook secret" });
    return { valid: false, error: "Webhook secret not configured" };
  }

  const parsed = parseSignatureHeader(signature);
  if (!parsed) {
    logError({ code: ErrorCode.STRIPE_SIGNATURE, detail: "invalid header format" });
    return { valid: false, error: "Invalid signature header format" };
  }

  const { timestamp, signatures } = parsed;

  // Check timestamp tolerance
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    logError({ code: ErrorCode.STRIPE_SIGNATURE, detail: "timestamp out of tolerance" });
    return { valid: false, error: "Timestamp outside tolerance window" };
  }

  // Compute expected signature
  const signedPayload = `${timestamp}.${payload}`;
  const expectedSignature = await computeSignature(signedPayload, secret);

  // Check if any signature matches (constant-time)
  const isValid = signatures.some((sig) => secureCompare(sig, expectedSignature));

  if (!isValid) {
    logError({ code: ErrorCode.STRIPE_SIGNATURE, detail: "mismatch" });
    return { valid: false, error: "Signature verification failed" };
  }

  // Parse and return the event
  try {
    const event = JSON.parse(payload) as StripeWebhookEvent;
    return { valid: true, event };
  } catch {
    logError({ code: ErrorCode.STRIPE_SIGNATURE, detail: "invalid JSON" });
    return { valid: false, error: "Invalid JSON payload" };
  }
};

/**
 * Construct a test webhook event (for testing purposes).
 * Generates a valid signature for the given payload.
 */
export const constructTestWebhookEvent = async (
  event: StripeWebhookEvent,
  secret: string,
): Promise<{ payload: string; signature: string }> => {
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${payload}`;
  const sig = await computeSignature(signedPayload, secret);

  return {
    payload,
    signature: `t=${timestamp},v1=${sig}`,
  };
};
