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
import { getStripeWebhookEndpointId } from "#lib/db/settings.ts";
import { getEnv } from "#lib/env.ts";
import { ErrorCode, logDebug, logError } from "#lib/logger.ts";
import { computeHmacSha256, hmacToHex, secureCompare } from "#lib/payment-crypto.ts";
import {
  buildMultiIntentMetadata,
  buildSingleIntentMetadata,
  createWithClient,
} from "#lib/payment-helpers.ts";
import type {
  MultiRegistrationIntent,
  RegistrationIntent,
  WebhookEvent,
  WebhookSetupResult,
  WebhookVerifyResult,
} from "#lib/payments.ts";
import type { Event } from "#lib/types.ts";

/** Lazy-load Stripe SDK only when needed */
const loadStripe = once(async () => {
  const { default: Stripe } = await import("stripe");
  return Stripe;
});

type StripeCache = { client: Stripe; secretKey: string };

/**
 * Extract a privacy-safe error detail from a caught error.
 * Stripe errors expose type/code/statusCode which are safe to log.
 * Raw message is never logged as it may contain PII or secrets.
 */
export const sanitizeErrorDetail = (err: unknown): string => {
  if (!(err instanceof Error)) return "unknown";

  // Stripe SDK errors have statusCode, code, and type properties
  const stripeErr = err as {
    statusCode?: number;
    code?: string;
    type?: string;
  };

  const parts: string[] = [];
  if (stripeErr.statusCode) parts.push(`status=${stripeErr.statusCode}`);
  if (stripeErr.code) parts.push(`code=${stripeErr.code}`);
  if (stripeErr.type) parts.push(`type=${stripeErr.type}`);

  return parts.length > 0 ? parts.join(" ") : err.name;
};

/**
 * Get Stripe client configuration for mock server (if configured)
 */
const getMockConfigImpl = (): Stripe.StripeConfig | undefined => {
  const mockHost = getEnv("STRIPE_MOCK_HOST");
  if (!mockHost) return undefined;

  const mockPort = Number.parseInt(
    getEnv("STRIPE_MOCK_PORT") || "12111",
    10,
  );
  return {
    host: mockHost,
    port: mockPort,
    protocol: "http",
  };
};

const [getMockConfig, setMockConfig] = lazyRef<Stripe.StripeConfig | undefined>(getMockConfigImpl);

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

/** Internal getStripeClient implementation */
const getClientImpl = async (): Promise<Stripe | null> => {
  const secretKey = await getStripeSecretKey();
  if (!secretKey) {
    logDebug("Stripe", "No secret key configured, cannot create client");
    return null;
  }

  try {
    const cached = getCache();
    if (cached.secretKey === secretKey) {
      logDebug("Stripe", "Using cached Stripe client");
      return cached.client;
    }
  } catch {
    // Cache not initialized
  }

  logDebug("Stripe", "Creating new Stripe client");
  const client = await createStripeClient(secretKey);
  setCache({ client, secretKey });
  return client;
};

/** Run operation with stripe client, return null if not available */
const withClient = createWithClient(getClientImpl);

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
            name: `Ticket: ${cfg.event.name}`,
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
    ...(cfg.email ? { customer_email: cfg.email } : {}),
    metadata: cfg.metadata,
  };
};

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
  createMultiCheckoutSession: (
    intent: MultiRegistrationIntent,
    baseUrl: string,
  ) => Promise<Stripe.Checkout.Session | null>;
  setupWebhookEndpoint: (
    secretKey: string,
    webhookUrl: string,
    existingEndpointId?: string | null,
  ) => Promise<WebhookSetupResult>;
  testStripeConnection: () => Promise<StripeConnectionTestResult>;
} = {
  /** Get or create Stripe client */
  getStripeClient: getClientImpl,

  /** Reset Stripe client (for testing) */
  resetStripeClient: (): void => {
    setCache(null);
    setMockConfig(null);
  },

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
    logDebug("Stripe", `Creating checkout session for event=${event.id} qty=${intent.quantity}`);
    const config = await buildSessionParams({
      event,
      quantity: intent.quantity,
      email: intent.email,
      successUrl: `${baseUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${baseUrl}/payment/cancel?session_id={CHECKOUT_SESSION_ID}`,
      metadata: buildSingleIntentMetadata(event.id, intent),
    });
    if (!config) {
      logDebug("Stripe", `Session params returned null for event=${event.id} (missing unit_price?)`);
      return null;
    }
    logDebug("Stripe", `Calling Stripe API checkout.sessions.create for event=${event.id}`);
    const session = await withClient(
      (stripe) => stripe.checkout.sessions.create(config),
      ErrorCode.STRIPE_CHECKOUT,
    );
    logDebug("Stripe", session ? `Session created id=${session.id} url=${session.url ?? "none"}` : `Session creation failed for event=${event.id}`);
    return session;
  },

  /** Create checkout session for multi-event registration */
  createMultiCheckoutSession: async (
    intent: MultiRegistrationIntent,
    baseUrl: string,
  ): Promise<Stripe.Checkout.Session | null> => {
    logDebug("Stripe", `Creating multi-checkout session for ${intent.items.length} events`);
    const currency = (await getCurrencyCode()).toLowerCase();

    // Build line items for each event
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] =
      intent.items.map((item) => ({
        price_data: {
          currency,
          product_data: {
            name: `Ticket: ${item.name}`,
            description:
              item.quantity > 1 ? `${item.quantity} Tickets` : "Ticket",
          },
          unit_amount: item.unitPrice,
        },
        quantity: item.quantity,
      }));

    const params: Stripe.Checkout.SessionCreateParams = {
      payment_method_types: ["card"],
      line_items: lineItems,
      mode: "payment",
      success_url: `${baseUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/payment/cancel?session_id={CHECKOUT_SESSION_ID}`,
      ...(intent.email ? { customer_email: intent.email } : {}),
      metadata: buildMultiIntentMetadata(intent),
    };

    logDebug("Stripe", "Calling Stripe API checkout.sessions.create for multi-checkout");
    const session = await withClient(
      (stripe) => stripe.checkout.sessions.create(params),
      ErrorCode.STRIPE_CHECKOUT,
    );
    logDebug("Stripe", session ? `Multi-session created id=${session.id} url=${session.url ?? "none"}` : "Multi-session creation failed");
    return session;
  },

  /** Test Stripe connection: verify API key and webhook endpoint */
  testStripeConnection: async (): Promise<StripeConnectionTestResult> => {
    const result: StripeConnectionTestResult = {
      ok: false,
      apiKey: { valid: false },
      webhook: { configured: false },
    };

    // Step 1: Test API key by retrieving balance
    const client = await getClientImpl();
    if (!client) {
      result.apiKey.error = "No Stripe secret key configured";
      return result;
    }

    try {
      const balance = await client.balance.retrieve();
      const hasLiveKey = balance.livemode;
      result.apiKey = {
        valid: true,
        mode: hasLiveKey ? "live" : "test",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      result.apiKey = { valid: false, error: message };
      return result;
    }

    // Step 2: Test webhook endpoint
    const endpointId = await getStripeWebhookEndpointId();
    if (!endpointId) {
      result.webhook = { configured: false, error: "No webhook endpoint ID stored" };
      return result;
    }

    try {
      const endpoint = await client.webhookEndpoints.retrieve(endpointId);
      result.webhook = {
        configured: true,
        endpointId: endpoint.id,
        url: endpoint.url,
        status: endpoint.status,
        enabledEvents: endpoint.enabled_events,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      result.webhook = { configured: false, endpointId, error: message };
      return result;
    }

    result.ok = result.apiKey.valid && result.webhook.configured;
    return result;
  },

  // Placeholder - will be set after setupWebhookEndpointImpl is defined
  setupWebhookEndpoint: null as unknown as (
    secretKey: string,
    webhookUrl: string,
    existingEndpointId?: string | null,
  ) => Promise<WebhookSetupResult>,
};

export type {
  RegistrationIntent,
  MultiRegistrationItem,
  MultiRegistrationIntent,
} from "#lib/payments.ts";

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
    logError({ code: ErrorCode.STRIPE_WEBHOOK_SETUP, detail: sanitizeErrorDetail(err) });
    return { success: false, error: err instanceof Error ? err.message : String(err) };
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
export const createMultiCheckoutSession = (
  i: MultiRegistrationIntent,
  b: string,
) => stripeApi.createMultiCheckoutSession(i, b);
export const testStripeConnection = () => stripeApi.testStripeConnection();

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

/** Compute HMAC-SHA256 and return hex-encoded result (Stripe format) */
const computeSignature = async (
  payload: string,
  secret: string,
): Promise<string> => hmacToHex(await computeHmacSha256(payload, secret));

/** Stripe webhook event - alias for the provider-agnostic WebhookEvent */
export type StripeWebhookEvent = WebhookEvent;
export type { WebhookSetupResult, WebhookVerifyResult };

/** Result of testing the Stripe connection */
export type StripeConnectionTestResult = {
  ok: boolean;
  apiKey: { valid: boolean; error?: string; mode?: string };
  webhook: {
    configured: boolean;
    endpointId?: string;
    url?: string;
    status?: string;
    enabledEvents?: string[];
    error?: string;
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
