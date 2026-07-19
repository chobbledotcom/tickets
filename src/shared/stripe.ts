/**
 * Stripe integration module for ticket payments
 * Uses the narrow edge-native Stripe REST client.
 */

/* jscpd:ignore-start */
import { lazyRef } from "#fp";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { settings } from "#shared/db/settings.ts";
import { getEnv } from "#shared/env.ts";
import { errorMessage } from "#shared/error-message.ts";
import { ErrorCode, logDebug, logError } from "#shared/logger.ts";
import { nowSeconds } from "#shared/now.ts";
import { hmacSha256Hex, secureCompare } from "#shared/payment-crypto.ts";
import {
  assembleCheckoutMetadata,
  buildProviderLineItems,
  type CredentialCheck,
  cachedClientFactory,
  createWithClient,
  type SignedTestWebhook,
  signedTestWebhook,
} from "#shared/payment-helpers.ts";
import type {
  CheckoutIntent,
  SetupWebhookEndpoint,
  WebhookEvent,
  WebhookSetupResult,
  WebhookVerifyResult,
} from "#shared/payments.ts";
import {
  createStripeClient as createRestClient,
  STRIPE_API_VERSION,
  STRIPE_MAX_NETWORK_RETRIES,
  STRIPE_TIMEOUT_MS,
  type StripeClient,
  type StripeClientConfig,
} from "#shared/stripe/client.ts";
import type {
  StripeCheckoutSession,
  StripePaymentIntent,
  StripeRefund,
  StripeWebhookEndpoint,
  StripeWebhookEndpointWrite,
} from "#shared/stripe/schemas.ts";
import { finishWebhookVerification } from "#shared/webhook-verification.ts";

/* jscpd:ignore-end */

/** Nullable checkout session result */
type CheckoutResult = StripeCheckoutSession | null;

/**
 * Narrowed checkout session — only the fields our provider needs.
 * Collapses Stripe's `string | PaymentIntent | null` unions down to `string | null`.
 */
export type StripeCheckoutFields = {
  id: string;
  payment_status: string;
  payment_intent: string | null;
  metadata: Record<string, string> | null;
  amount_total: number | null;
  /** Session creation time as a Unix epoch (seconds), Stripe's native format. */
  created: number;
};

const narrowCheckoutSession = (
  session: StripeCheckoutSession,
): StripeCheckoutFields => ({
  amount_total: session.amount_total,
  created: session.created,
  id: session.id,
  metadata: session.metadata,
  payment_intent: session.payment_intent,
  payment_status: session.payment_status,
});

/**
 * Convert a Unix epoch (seconds) to an ISO 8601 string, or undefined when the
 * value isn't a number. Stripe timestamps (e.g. a checkout session's `created`)
 * are epoch seconds, while the ledger wants an ISO occurredAt.
 */
export const isoFromUnixSeconds = (seconds: unknown): string | undefined =>
  typeof seconds === "number"
    ? new Date(seconds * 1000).toISOString()
    : undefined;

/**
 * Narrowed payment intent with expanded latest_charge.
 * We call retrieve with `expand: ["latest_charge"]`, so it's always a Charge object.
 */
export type StripePaymentIntentFields = {
  id: string;
  latest_charge: { refunded: boolean } | null;
};

const narrowPaymentIntent = (
  intent: StripePaymentIntent,
): StripePaymentIntentFields => ({
  id: intent.id,
  latest_charge:
    intent.latest_charge &&
    typeof intent.latest_charge === "object" &&
    "refunded" in intent.latest_charge
      ? { refunded: intent.latest_charge.refunded }
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
  if ("statusCode" in err && typeof err.statusCode === "number") {
    parts.push(`status=${err.statusCode}`);
  }
  if ("code" in err && typeof err.code === "string") {
    parts.push(`code=${err.code}`);
  }
  if ("type" in err && typeof err.type === "string") {
    parts.push(`type=${err.type}`);
  }
  if ("requestId" in err && typeof err.requestId === "string") {
    parts.push(`request=${err.requestId}`);
  }

  return parts.length > 0 ? parts.join(" ") : err.name;
};

const STRIPE_CLIENT_CONFIG = {
  maxNetworkRetries: STRIPE_MAX_NETWORK_RETRIES,
  timeout: STRIPE_TIMEOUT_MS,
} satisfies StripeClientConfig;

/**
 * Get Stripe client configuration for mock server (if configured)
 */
const getMockConfigImpl = (): StripeClientConfig | undefined => {
  const mockHost = getEnv("STRIPE_MOCK_HOST");
  if (!mockHost) return;

  const mockPort = Number.parseInt(getEnv("STRIPE_MOCK_PORT") || "12111", 10);
  return {
    ...STRIPE_CLIENT_CONFIG,
    apiBase: `http://${mockHost}:${mockPort}`,
    maxNetworkRetries: 0,
  };
};

const [getMockConfig, setMockConfig] = lazyRef<StripeClientConfig | undefined>(
  getMockConfigImpl,
);

const createStripeClient = (secretKey: string): StripeClient => {
  const mockConfig = getMockConfig();
  return createRestClient(secretKey, mockConfig ?? STRIPE_CLIENT_CONFIG);
};

const clientCache = cachedClientFactory({
  create: createStripeClient,
  getConfig: () => settings.stripe.secretKey || null,
  isSameConfig: (a: string, b: string) => a === b,
  missingMessage: "No secret key configured, cannot create client",
  provider: "Stripe",
});

/** Internal getStripeClient implementation */
const getClientImpl = (): Promise<StripeClient | null> =>
  clientCache.getClient();

/** Run operation with stripe client, return null if not available */
const withClient = createWithClient(getClientImpl, sanitizeErrorDetail);

type StripeCheckoutLineItem = {
  price_data: {
    currency: string;
    product_data: { description?: string; name: string };
    unit_amount: number;
  };
  quantity: number;
};

/**
 * Fetch the site's webhook endpoint records from Stripe (one page, max 100).
 */
const fetchWebhookEndpoints = async (
  client: StripeClient,
): Promise<StripeWebhookEndpoint[]> => {
  const endpoints = await client.webhookEndpoints.list({ limit: 100 });
  return endpoints.data;
};

/** List the IDs of webhook endpoints pointing at the given URL. */
const listSameUrlEndpointIds = async (
  client: StripeClient,
  webhookUrl: string,
): Promise<string[]> => {
  const endpoints = await fetchWebhookEndpoints(client);
  return endpoints.filter((ep) => ep.url === webhookUrl).map((ep) => ep.id);
};

/** List same-URL endpoints other than the one the database currently names. */
const listStaleEndpointIds = async (
  client: StripeClient,
  webhookUrl: string,
  keepEndpointId: string | null | undefined,
): Promise<string[]> =>
  (await listSameUrlEndpointIds(client, webhookUrl)).filter(
    (id) => id !== keepEndpointId,
  );

/** Delete the given endpoint IDs. */
const deleteWebhookEndpoints = async (
  client: StripeClient,
  ids: string[],
): Promise<void> => {
  for (const id of ids) {
    await client.webhookEndpoints.del(id);
  }
};

/** Create the checkout-completion webhook endpoint at the given URL. */
const createCheckoutWebhook = async (
  client: StripeClient,
  webhookUrl: string,
): Promise<StripeWebhookEndpointWrite> =>
  client.webhookEndpoints.create({
    api_version: STRIPE_API_VERSION,
    enabled_events: ["checkout.session.completed"],
    url: webhookUrl,
  });

/** Check if a Stripe error looks like the webhook endpoint cap was reached.
 *  The Stripe SDK always wraps fetch errors in an Error subclass, so `err`
 *  is always an Error with a `.message` string. */
const isEndpointLimitError = (err: unknown): boolean => {
  const message = (err as Error).message.toLowerCase();
  return (
    message.includes("webhook") &&
    (message.includes("limit") || message.includes("maximum"))
  );
};

/**
 * Internal implementation of webhook endpoint setup.
 *
 * Creates the new endpoint but does NOT delete old ones — the caller must
 * save all new Stripe credentials to the DB first, then call
 * {@link cleanupOldWebhookEndpoints} to delete stale same-URL endpoints.
 * This ordering ensures a DB-save failure leaves the old endpoint (whose
 * secret matches the DB) in place, so webhooks keep delivering.
 *
 * If Stripe rejects the create because the account is at its webhook-endpoint
 * cap, deletes stale endpoints for the same URL and retries. The endpoint
 * named by the current database credentials is never deleted here. If no stale
 * endpoint can free a slot, the cap error is returned and the current endpoint
 * stays live.
 */
const setupWebhookEndpointImpl: SetupWebhookEndpoint = async (
  secretKey,
  webhookUrl,
  existingEndpointId,
) => {
  try {
    const client = await createStripeClient(secretKey);

    let endpoint: StripeWebhookEndpointWrite;
    try {
      endpoint = await createCheckoutWebhook(client, webhookUrl);
    } catch (err) {
      if (!isEndpointLimitError(err)) throw err;

      const staleIds = await listStaleEndpointIds(
        client,
        webhookUrl,
        existingEndpointId,
      );
      if (staleIds.length === 0) throw err;
      await deleteWebhookEndpoints(client, staleIds);
      endpoint = await createCheckoutWebhook(client, webhookUrl);
    }

    if (!endpoint.secret) {
      return { error: "Stripe did not return webhook secret", success: false };
    }

    return {
      endpointId: endpoint.id,
      secret: endpoint.secret,
      success: true,
    };
  } catch (err) {
    logError({
      code: ErrorCode.STRIPE_WEBHOOK_SETUP,
      detail: sanitizeErrorDetail(err),
    });
    return { error: errorMessage(err), success: false };
  }
};

/** Implementation of {@link cleanupOldWebhookEndpoints}. */
const cleanupOldWebhookEndpointsImpl = async (
  secretKey: string,
  webhookUrl: string,
  keepEndpointId: string,
  alsoDeleteIds: readonly string[] = [],
): Promise<void> => {
  const client = await createStripeClient(secretKey);
  const sameUrlStaleIds = await listStaleEndpointIds(
    client,
    webhookUrl,
    keepEndpointId,
  );
  // Merge same-URL strays with explicit IDs to delete (e.g. the old
  // recorded endpoint after a domain change, which is at a different URL).
  const allIds = [...new Set([...sameUrlStaleIds, ...alsoDeleteIds])].filter(
    (id) => id !== keepEndpointId,
  );
  await deleteWebhookEndpoints(client, allIds);
};

/**
 * Stubbable API for testing - allows mocking in ES modules
 * Production code uses stripeApi.method() to enable test mocking
 */
export const stripeApi: {
  cleanupOldWebhookEndpoints: (
    secretKey: string,
    webhookUrl: string,
    keepEndpointId: string,
    alsoDeleteIds?: readonly string[],
  ) => Promise<void>;
  getStripeClient: () => Promise<StripeClient | null>;
  resetStripeClient: () => void;
  retrieveCheckoutSession: (id: string) => Promise<StripeCheckoutFields | null>;
  retrievePaymentIntent: (
    id: string,
  ) => Promise<StripePaymentIntentFields | null>;
  refundPayment: (intentId: string) => Promise<StripeRefund | null>;
  createCheckoutSession: (
    intent: CheckoutIntent,
    baseUrl: string,
  ) => Promise<StripeCheckoutSession | null>;
  setupWebhookEndpoint: SetupWebhookEndpoint;
  testStripeConnection: () => Promise<StripeConnectionTestResult>;
} = {
  /** Delete old webhook endpoints pointing at the same URL, keeping the one
   *  with the given ID. Called by the settings route after all new Stripe
   *  credentials are saved. */
  cleanupOldWebhookEndpoints: cleanupOldWebhookEndpointsImpl,
  /** Create checkout session for one or more listings */
  createCheckoutSession: async (
    intent: CheckoutIntent,
    baseUrl: string,
  ): Promise<CheckoutResult> => {
    logDebug(
      "Stripe",
      `Creating checkout session for ${intent.items.length} listing(s)`,
    );
    const currency = settings.currency.toLowerCase();

    // Price the order once and reuse that total for both the charged line items
    // and the signed proof, so the two can never disagree (see #1300).
    const order = priceCheckout(intent);

    // Build line items (tickets + extras like the booking fee) from the
    // provider-agnostic priced order.
    const lineItems = buildProviderLineItems<StripeCheckoutLineItem>(
      order,
      currency,
      {
        extra: (extra, cur) => ({
          price_data: {
            currency: cur,
            product_data: { name: extra.name },
            unit_amount: extra.amount,
          },
          quantity: extra.quantity,
        }),
        line: (line, cur) => ({
          price_data: {
            currency: cur,
            product_data: {
              description:
                line.quantity > 1 ? `${line.quantity} Tickets` : "Ticket",
              name: `Ticket: ${line.item.name}`,
            },
            unit_amount: line.chargedUnitAmount,
          },
          quantity: line.quantity,
        }),
      },
    );

    const params = {
      cancel_url: `${baseUrl}/payment/cancel?session_id={CHECKOUT_SESSION_ID}`,
      line_items: lineItems,
      mode: "payment",
      payment_method_types: ["card"],
      success_url: `${baseUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      ...(intent.email ? { customer_email: intent.email } : {}),
      metadata: await assembleCheckoutMetadata("stripe", intent, order.total),
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
  /** Get or create Stripe client */
  getStripeClient: getClientImpl,

  /** Refund a payment */
  refundPayment: (intentId: string): Promise<StripeRefund | null> =>
    withClient(
      (s) => s.refunds.create({ payment_intent: intentId }),
      ErrorCode.STRIPE_REFUND,
    ),

  /** Reset Stripe client (for testing) */
  resetStripeClient: (): void => {
    clientCache.reset();
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

  setupWebhookEndpoint: setupWebhookEndpointImpl,

  /** Test Stripe connection: verify API key and list all webhook endpoints */
  testStripeConnection: async (): Promise<StripeConnectionTestResult> => {
    const result: StripeConnectionTestResult = {
      apiKey: { valid: false },
      ok: false,
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
        mode: hasLiveKey ? "live" : "test",
        valid: true,
      };
    } catch (err) {
      const message = errorMessage(err);
      result.apiKey = { error: message, valid: false };
      return result;
    }

    // Step 2: List all webhook endpoints
    result.ownEndpointId = settings.stripe.webhookEndpointId;

    try {
      const endpoints = await fetchWebhookEndpoints(client);
      result.webhooks = endpoints.map((ep) => ({
        enabledEvents: ep.enabled_events,
        endpointId: ep.id,
        status: ep.status,
        url: ep.url,
      }));
    } catch (err) {
      const message = errorMessage(err);
      result.webhookError = message;
      return result;
    }

    result.ok = result.apiKey.valid && result.webhooks.length > 0;
    return result;
  },
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

/** Delete old webhook endpoints at the same URL, keeping `keepEndpointId`.
 * Listing and deletion failures propagate to the settings request. */
export const cleanupOldWebhookEndpoints = (
  ...args: Parameters<typeof cleanupOldWebhookEndpointsImpl>
): Promise<void> => stripeApi.cleanupOldWebhookEndpoints(...args);

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

  return { ok: true, signatures, timestamp };
};

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
  apiKey: CredentialCheck;
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
 * @param toleranceSeconds - Max age of listing in seconds (default: 300)
 */
export const verifyWebhookSignature = async (
  payload: string,
  signature: string,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): Promise<WebhookVerifyResult> => {
  const secret = settings.stripe.webhookSecret;
  if (!secret) {
    logError({ code: ErrorCode.CONFIG_MISSING, detail: "webhook secret" });
    return { error: "Webhook secret not configured", valid: false };
  }

  const parsed = parseSignatureHeader(signature);
  if (!parsed.ok) {
    logError({
      code: ErrorCode.STRIPE_SIGNATURE,
      detail: `invalid header: ${parsed.reason}`,
    });
    return { error: "Invalid signature header format", valid: false };
  }

  const { timestamp, signatures } = parsed;

  // Check timestamp tolerance
  const nowSecs = nowSeconds();
  const timestampDelta = nowSecs - timestamp;
  if (Math.abs(timestampDelta) > toleranceSeconds) {
    logError({
      code: ErrorCode.STRIPE_SIGNATURE,
      detail: `timestamp out of tolerance delta=${timestampDelta}s tolerance=${toleranceSeconds}s`,
    });
    return { error: "Timestamp outside tolerance window", valid: false };
  }

  // Compute expected signature
  const signedPayload = `${timestamp}.${payload}`;
  const expectedSignature = await hmacSha256Hex(signedPayload, secret);

  // Check if any signature matches (constant-time)
  const isValid = signatures.some((sig) =>
    secureCompare(sig, expectedSignature),
  );

  if (!isValid) {
    logError({ code: ErrorCode.STRIPE_SIGNATURE, detail: "mismatch" });
  }

  return finishWebhookVerification(
    isValid,
    payload,
    ErrorCode.STRIPE_SIGNATURE,
  );
};

/**
 * Construct a test webhook event (for testing purposes).
 * Generates a valid signature for the given payload.
 */
export const constructTestWebhookEvent = (
  listing: StripeWebhookEvent,
  secret: string,
): Promise<SignedTestWebhook> =>
  signedTestWebhook(listing, async (payload) => {
    const timestamp = nowSeconds();
    const sig = await hmacSha256Hex(`${timestamp}.${payload}`, secret);
    return `t=${timestamp},v1=${sig}`;
  });
