/**
 * Stripe integration module for ticket payments
 * Uses lazy loading to avoid importing the Stripe SDK at startup
 */

import type Stripe from "stripe";
import { lazyRef, once } from "#fp";
import { getBookingFeeAmount, itemsSubtotal } from "#lib/booking-fee.ts";
import { settings } from "#lib/db/settings.ts";
import { getEnv } from "#lib/env.ts";
import { ErrorCode, logDebug, logError } from "#lib/logger.ts";
import { nowMs } from "#lib/now.ts";
import {
  computeHmacSha256,
  hmacToHex,
  secureCompare,
} from "#lib/payment-crypto.ts";
import {
  buildItemsMetadata,
  createWithClient,
  errorMessage,
} from "#lib/payment-helpers.ts";
import type {
  CheckoutIntent,
  WebhookEvent,
  WebhookSetupResult,
  WebhookVerifyResult,
} from "#lib/payments.ts";

/** Lazy-load Stripe SDK only when needed */
const loadStripe = once(async () => {
  const { default: Stripe } = await import("stripe");
  return Stripe;
});

type StripeCache = { client: Stripe; secretKey: string };

/** Nullable checkout session result */
type CheckoutResult = Stripe.Checkout.Session | null;

/**
 * Narrowed checkout session with only the fields our provider needs.
 * Stripe SDK types `payment_intent` as `string | PaymentIntent | null`
 * but we never expand it, so it's always a string ID (or null).
 */
export type StripeCheckoutFields = {
  id: string;
  payment_status: string;
  payment_intent: string | null;
  metadata: Record<string, string> | null;
  amount_total: number | null;
};

/** Extract only the fields we need, narrowing Stripe's broad union types */
const narrowCheckoutSession = (
  session: Stripe.Checkout.Session,
): StripeCheckoutFields => ({
  id: session.id,
  payment_status: session.payment_status,
  payment_intent:
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent?.id ?? null),
  metadata: session.metadata,
  amount_total: session.amount_total,
});

/**
 * Narrowed payment intent with expanded latest_charge.
 * We always call retrieve with `expand: ["latest_charge"]`,
 * so latest_charge is a Charge object (not a string ID).
 */
export type StripePaymentIntentFields = {
  id: string;
  latest_charge: { refunded: boolean } | null;
};

/** Extract narrowed payment intent fields */
const narrowPaymentIntent = (
  intent: Stripe.PaymentIntent,
): StripePaymentIntentFields => ({
  id: intent.id,
  latest_charge:
    typeof intent.latest_charge === "object" && intent.latest_charge !== null
      ? { refunded: (intent.latest_charge as Stripe.Charge).refunded }
      : null,
});

/** Valid Stripe secret key prefixes */
const STRIPE_KEY_PREFIX_TEST = "sk_test_";
const STRIPE_KEY_PREFIX_LIVE = "sk_live_";

/** Stripe key mode: "test" for sandbox keys, "live" for production keys */
export type StripeKeyMode = "test" | "live";

/**
 * Detect the mode (test or live) from a Stripe secret key prefix.
 * Returns null if the key doesn't match a known prefix.
 */
export const detectStripeKeyMode = (key: string): StripeKeyMode | null => {
  if (key.startsWith(STRIPE_KEY_PREFIX_TEST)) return "test";
  if (key.startsWith(STRIPE_KEY_PREFIX_LIVE)) return "live";
  return null;
};

/**
 * Extract a privacy-safe error detail from a caught error.
 * Stripe errors expose type/code/statusCode which are safe to log.
 * Raw message is never logged as it may contain PII or secrets.
 */
export const sanitizeErrorDetail = (err: unknown): string => {
  if (!(err instanceof Error)) return "unknown";

  // Stripe SDK errors have statusCode, code, and type properties.
  // Use "in" narrowing instead of a blanket type assertion.
  const parts: string[] = [];
  if ("statusCode" in err && typeof err.statusCode === "number")
    parts.push(`status=${err.statusCode}`);
  if ("code" in err && typeof err.code === "string")
    parts.push(`code=${err.code}`);
  if ("type" in err && typeof err.type === "string")
    parts.push(`type=${err.type}`);

  return parts.length > 0 ? parts.join(" ") : err.name;
};

/**
 * Get Stripe client configuration for mock server (if configured)
 */
const getMockConfigImpl = (): Stripe.StripeConfig | undefined => {
  const mockHost = getEnv("STRIPE_MOCK_HOST");
  if (!mockHost) return undefined;

  const mockPort = Number.parseInt(getEnv("STRIPE_MOCK_PORT") || "12111", 10);
  return {
    host: mockHost,
    port: mockPort,
    protocol: "http",
    maxNetworkRetries: 0,
  };
};

const [getMockConfig, setMockConfig] = lazyRef<Stripe.StripeConfig | undefined>(
  getMockConfigImpl,
);

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
  const secretKey = settings.stripe.secretKey;
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

/** Build a Stripe fee line item array (empty when fee is zero). */
const stripeFeeItems = (
  subtotal: number,
  currency: string,
): Stripe.Checkout.SessionCreateParams.LineItem[] => {
  const amount = getBookingFeeAmount(subtotal);
  if (amount <= 0) return [];
  return [
    {
      price_data: {
        currency,
        product_data: { name: "Booking fee" },
        unit_amount: amount,
      },
      quantity: 1,
    },
  ];
};

/**
 * Internal implementation of webhook endpoint setup.
 * Defined before stripeApi so it can be assigned directly.
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

    // Create new webhook endpoint (preserves any existing webhooks)
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
    logError({
      code: ErrorCode.STRIPE_WEBHOOK_SETUP,
      detail: sanitizeErrorDetail(err),
    });
    return { success: false, error: errorMessage(err) };
  }
};

/**
 * Stubbable API for testing - allows mocking in ES modules
 * Production code uses stripeApi.method() to enable test mocking
 */
export const stripeApi: {
  getStripeClient: () => Promise<Stripe | null>;
  resetStripeClient: () => void;
  retrieveCheckoutSession: (id: string) => Promise<StripeCheckoutFields | null>;
  retrievePaymentIntent: (
    id: string,
  ) => Promise<StripePaymentIntentFields | null>;
  refundPayment: (intentId: string) => Promise<Stripe.Refund | null>;
  createCheckoutSession: (
    intent: CheckoutIntent,
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

  /** Retrieve checkout session (narrowed to only the fields we use) */
  retrieveCheckoutSession: async (
    id: string,
  ): Promise<StripeCheckoutFields | null> => {
    const session = await withClient(
      (s) => s.checkout.sessions.retrieve(id),
      ErrorCode.STRIPE_SESSION,
    );
    return session ? narrowCheckoutSession(session) : null;
  },

  /** Retrieve a payment intent with expanded charge (narrowed) */
  retrievePaymentIntent: async (
    id: string,
  ): Promise<StripePaymentIntentFields | null> => {
    const intent = await withClient(
      (s) => s.paymentIntents.retrieve(id, { expand: ["latest_charge"] }),
      ErrorCode.STRIPE_SESSION,
    );
    return intent ? narrowPaymentIntent(intent) : null;
  },

  /** Refund a payment */
  refundPayment: (intentId: string): Promise<Stripe.Refund | null> =>
    withClient(
      (s) => s.refunds.create({ payment_intent: intentId }),
      ErrorCode.STRIPE_REFUND,
    ),

  /** Create checkout session for one or more events */
  createCheckoutSession: async (
    intent: CheckoutIntent,
    baseUrl: string,
  ): Promise<CheckoutResult> => {
    logDebug(
      "Stripe",
      `Creating checkout session for ${intent.items.length} event(s)`,
    );
    const currency = settings.currency.toLowerCase();

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

    lineItems.push(...stripeFeeItems(itemsSubtotal(intent.items), currency));

    const params: Stripe.Checkout.SessionCreateParams = {
      payment_method_types: ["card"],
      line_items: lineItems,
      mode: "payment",
      success_url: `${baseUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/payment/cancel?session_id={CHECKOUT_SESSION_ID}`,
      ...(intent.email ? { customer_email: intent.email } : {}),
      metadata: buildItemsMetadata(intent),
    };

    logDebug("Stripe", "Calling Stripe API checkout.sessions.create");
    const session = await withClient(
      (stripe) => stripe.checkout.sessions.create(params),
      ErrorCode.STRIPE_CHECKOUT,
    );
    logDebug(
      "Stripe",
      session
        ? `Multi-session created id=${session.id} url=${session.url ?? "none"}`
        : "Multi-session creation failed",
    );
    return session;
  },

  /** Test Stripe connection: verify API key and list all webhook endpoints */
  testStripeConnection: async (): Promise<StripeConnectionTestResult> => {
    const result: StripeConnectionTestResult = {
      ok: false,
      apiKey: { valid: false },
      webhooks: [],
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
      const message = errorMessage(err);
      result.apiKey = { valid: false, error: message };
      return result;
    }

    // Step 2: List all webhook endpoints
    result.ownEndpointId = settings.stripe.webhookEndpointId;

    try {
      const endpoints = await client.webhookEndpoints.list({ limit: 100 });
      result.webhooks = endpoints.data.map((ep) => ({
        endpointId: ep.id,
        url: ep.url,
        status: ep.status,
        enabledEvents: ep.enabled_events,
      }));
    } catch (err) {
      const message = errorMessage(err);
      result.webhookError = message;
      return result;
    }

    result.ok = result.apiKey.valid && result.webhooks.length > 0;
    return result;
  },

  setupWebhookEndpoint: setupWebhookEndpointImpl,
};

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
  ...args: Parameters<typeof setupWebhookEndpointImpl>
): Promise<WebhookSetupResult> => stripeApi.setupWebhookEndpoint(...args);

// Wrapper functions that delegate to stripeApi at runtime (enables test mocking)
export const getStripeClient = () => stripeApi.getStripeClient();
export const resetStripeClient = () => stripeApi.resetStripeClient();
export const retrieveCheckoutSession = (id: string) =>
  stripeApi.retrieveCheckoutSession(id);
export const retrievePaymentIntent = (id: string) =>
  stripeApi.retrievePaymentIntent(id);
export const refundPayment = (id: string) => stripeApi.refundPayment(id);
export const createCheckoutSession = (i: CheckoutIntent, b: string) =>
  stripeApi.createCheckoutSession(i, b);
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

/** Result of parsing a Stripe signature header */
type SignatureParseResult =
  | { ok: true; timestamp: number; signatures: string[] }
  | { ok: false; reason: string };

/** Parse Stripe signature header into components */
const parseSignatureHeader = (header: string): SignatureParseResult => {
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

  if (timestamp === 0 && signatures.length === 0) {
    return { ok: false, reason: "missing timestamp and signature" };
  }
  if (timestamp === 0) {
    return { ok: false, reason: "missing timestamp" };
  }
  if (signatures.length === 0) {
    return { ok: false, reason: "missing signature" };
  }

  return { ok: true, timestamp, signatures };
};

/** Compute HMAC-SHA256 and return hex-encoded result (Stripe format) */
const computeSignature = async (
  payload: string,
  secret: string,
): Promise<string> =>
  hmacToHex(await computeHmacSha256(new TextEncoder().encode(payload), secret));

/** Stripe webhook event - alias for the provider-agnostic WebhookEvent */
export type StripeWebhookEvent = WebhookEvent;
export type { WebhookSetupResult, WebhookVerifyResult };

/** A single webhook endpoint's status */
export type WebhookEndpointStatus = {
  endpointId: string;
  url: string;
  status: string;
  enabledEvents: string[];
};

/** Result of testing the Stripe connection */
export type StripeConnectionTestResult = {
  ok: boolean;
  apiKey: { valid: boolean; error?: string; mode?: string };
  webhooks: WebhookEndpointStatus[];
  ownEndpointId?: string | null;
  webhookError?: string;
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
  const secret = settings.stripe.webhookSecret;
  if (!secret) {
    logError({ code: ErrorCode.CONFIG_MISSING, detail: "webhook secret" });
    return { valid: false, error: "Webhook secret not configured" };
  }

  const parsed = parseSignatureHeader(signature);
  if (!parsed.ok) {
    logError({
      code: ErrorCode.STRIPE_SIGNATURE,
      detail: `invalid header: ${parsed.reason}`,
    });
    return { valid: false, error: "Invalid signature header format" };
  }

  const { timestamp, signatures } = parsed;

  // Check timestamp tolerance
  const nowSecs = Math.floor(nowMs() / 1000);
  const timestampDelta = nowSecs - timestamp;
  if (Math.abs(timestampDelta) > toleranceSeconds) {
    logError({
      code: ErrorCode.STRIPE_SIGNATURE,
      detail: `timestamp out of tolerance delta=${timestampDelta}s tolerance=${toleranceSeconds}s`,
    });
    return { valid: false, error: "Timestamp outside tolerance window" };
  }

  // Compute expected signature
  const signedPayload = `${timestamp}.${payload}`;
  const expectedSignature = await computeSignature(signedPayload, secret);

  // Check if any signature matches (constant-time)
  const isValid = signatures.some((sig) =>
    secureCompare(sig, expectedSignature),
  );

  if (!isValid) {
    logError({ code: ErrorCode.STRIPE_SIGNATURE, detail: "mismatch" });
    return { valid: false, error: "Signature verification failed" };
  }

  // Parse and return the event
  try {
    const event = JSON.parse(payload) as StripeWebhookEvent;
    return { valid: true, event };
  } catch (err) {
    logError({
      code: ErrorCode.STRIPE_SIGNATURE,
      detail: `invalid JSON: ${err}`,
    });
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
  const timestamp = Math.floor(nowMs() / 1000);
  const signedPayload = `${timestamp}.${payload}`;
  const sig = await computeSignature(signedPayload, secret);

  return {
    payload,
    signature: `t=${timestamp},v1=${sig}`,
  };
};
