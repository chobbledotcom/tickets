/**
 * Square integration module for ticket payments
 * Uses lazy loading to avoid importing the Square SDK at startup
 *
 * Square flow differs from Stripe:
 * - Checkout uses Payment Links (CreatePaymentLink) instead of sessions
 * - Metadata is stored on the Order object
 * - Webhook event is payment.updated (check status === "COMPLETED")
 * - Webhook signature uses HMAC-SHA256 of notification_url + body
 * - Retrieving session data requires fetching the Order by ID
 */

import type { Square } from "square";
import { lazyRef, map, once } from "#fp";
import {
  getCurrencyCode,
  getSquareAccessToken,
  getSquareLocationId,
  getSquareWebhookSignatureKey,
} from "#lib/config.ts";
import { ErrorCode, logDebug, logError } from "#lib/logger.ts";
import {
  buildMultiIntentMetadata,
  buildSingleIntentMetadata,
  createWithClient,
} from "#lib/payment-helpers.ts";

import { computeHmacSha256, hmacToBase64, secureCompare } from "#lib/payment-crypto.ts";
import type {
  MultiRegistrationIntent,
  RegistrationIntent,
  WebhookEvent,
  WebhookVerifyResult,
} from "#lib/payments.ts";
import type { Event } from "#lib/types.ts";

/**
 * Square order metadata constraints (from Square API docs):
 * - Max 10 entries per metadata field
 * - Key max 60 characters
 * - Value max 255 characters
 */
const SQUARE_METADATA_MAX_VALUE_LENGTH = 255;

/**
 * Enforce Square metadata value length limits.
 * Truncates `name` (display-only, safe to shorten).
 * Returns null if any non-truncatable value (like `items` JSON) exceeds the limit,
 * since truncating structured data would cause downstream parse failures.
 */
export const enforceMetadataLimits = (
  metadata: Record<string, string>,
): Record<string, string> | null => {
  for (const [key, value] of Object.entries(metadata)) {
    if (value.length <= SQUARE_METADATA_MAX_VALUE_LENGTH) continue;
    if (key === "name") continue; // handled below
    logError({
      code: ErrorCode.SQUARE_CHECKOUT,
      detail: `Metadata value for "${key}" exceeds ${SQUARE_METADATA_MAX_VALUE_LENGTH} chars (${value.length})`,
    });
    return null;
  }

  const name = metadata.name;
  if (name && name.length > SQUARE_METADATA_MAX_VALUE_LENGTH) {
    return { ...metadata, name: name.slice(0, SQUARE_METADATA_MAX_VALUE_LENGTH) };
  }

  return metadata;
};

/** Lazy-load Square SDK only when needed */
const loadSquare = once(async () => {
  const { SquareClient } = await import("square");
  return SquareClient;
});

type SquareCache = { accessToken: string };

const [getCache, setCache] = lazyRef<SquareCache>(() => {
  throw new Error("Square cache not initialized");
});

/** Create a Square client instance */
const createSquareClient = async (accessToken: string) => {
  const SquareClient = await loadSquare();
  return new SquareClient({ token: accessToken });
};

/** Internal getSquareClient implementation */
const getClientImpl = async () => {
  const accessToken = await getSquareAccessToken();
  if (!accessToken) {
    logDebug("Square", "No access token configured, cannot create client");
    return null;
  }

  try {
    const cached = getCache();
    if (cached.accessToken === accessToken) {
      logDebug("Square", "Using cached Square client");
      return createSquareClient(accessToken);
    }
  } catch {
    // Cache not initialized
  }

  logDebug("Square", "Creating new Square client");
  setCache({ accessToken });
  return createSquareClient(accessToken);
};

/** Run operation with Square client, return null if not available */
const withClient = createWithClient(() => squareApi.getSquareClient());

/** Get the configured location ID */
const getLocationId = async (): Promise<string | null> => {
  const locationId = await getSquareLocationId();
  if (!locationId) {
    logDebug("Square", "No location ID configured");
    return null;
  }
  return locationId;
};

/** Resolved location and currency for payment link creation */
type PaymentLinkConfig = { locationId: string; currency: Square.Currency };

/** Get location ID and currency, returning null if location is not configured */
const getPaymentLinkConfig = async (): Promise<PaymentLinkConfig | null> => {
  const locationId = await getLocationId();
  if (!locationId) return null;
  const currency = (await getCurrencyCode()).toUpperCase() as Square.Currency;
  return { locationId, currency };
};

/** Square order response shape (subset we use) */
type SquareOrder = {
  id?: string;
  metadata?: Record<string, string>;
  tenders?: Array<{
    id?: string;
    paymentId?: string;
  }>;
  state?: string;
};

/** Square payment response shape (subset we use) */
type SquarePayment = {
  id?: string;
  status?: string;
  orderId?: string;
  amountMoney?: {
    amount?: bigint;
    currency?: string;
  };
};

/** Result of creating a payment link */
export type PaymentLinkResult = {
  orderId: string;
  url: string;
} | null;

/** Common parameters for creating a payment link */
type PaymentLinkParams = {
  locationId: string;
  currency: Square.Currency;
  lineItems: Array<{
    name: string;
    quantity: string;
    note: string;
    basePriceMoney: { amount: bigint; currency: Square.Currency };
  }>;
  metadata: Record<string, string>;
  baseUrl: string;
  email: string;
  phone?: string;
  label: string;
};

/** Create a payment link via Square Checkout API */
const createPaymentLinkImpl = (
  params: PaymentLinkParams,
): Promise<PaymentLinkResult> =>
  withClient(
    async (client) => {
      const response = await client.checkout.paymentLinks.create({
        idempotencyKey: crypto.randomUUID(),
        order: {
          locationId: params.locationId,
          lineItems: params.lineItems,
          metadata: params.metadata,
        },
        checkoutOptions: {
          redirectUrl: `${params.baseUrl}/payment/success?session_id={ORDER_ID}`,
        },
        prePopulatedData: {
          buyerEmail: params.email,
          ...(params.phone ? { buyerPhoneNumber: params.phone } : {}),
        },
      });

      const link = response.paymentLink;
      const orderId = link?.orderId;
      const url = link?.url;

      if (!orderId || !url) {
        logDebug("Square", `${params.label} response missing orderId or url`);
        return null;
      }

      return { orderId, url };
    },
    ErrorCode.SQUARE_CHECKOUT,
  );

/**
 * Stubbable API for testing - allows mocking in ES modules
 */
export const squareApi: {
  getSquareClient: () => ReturnType<typeof getClientImpl>;
  resetSquareClient: () => void;
  createPaymentLink: (
    event: Event,
    intent: RegistrationIntent,
    baseUrl: string,
  ) => Promise<PaymentLinkResult>;
  createMultiPaymentLink: (
    intent: MultiRegistrationIntent,
    baseUrl: string,
  ) => Promise<PaymentLinkResult>;
  retrieveOrder: (orderId: string) => Promise<SquareOrder | null>;
  retrievePayment: (paymentId: string) => Promise<SquarePayment | null>;
  refundPayment: (paymentId: string) => Promise<boolean>;
} = {
  getSquareClient: getClientImpl,

  resetSquareClient: (): void => setCache(null),

  /** Create a payment link for a single-event purchase */
  createPaymentLink: async (
    event: Event,
    intent: RegistrationIntent,
    baseUrl: string,
  ): Promise<PaymentLinkResult> => {
    if (event.unit_price === null) {
      logDebug("Square", `No unit_price for event=${event.id}`);
      return null;
    }

    const config = await getPaymentLinkConfig();
    if (!config) return null;

    logDebug("Square", `Creating payment link for event=${event.id} qty=${intent.quantity}`);

    const metadata = enforceMetadataLimits(buildSingleIntentMetadata(event.id, intent));
    if (!metadata) return null;

    const result = await createPaymentLinkImpl({
      ...config,
      lineItems: [
        {
          name: `Ticket: ${event.name}`,
          quantity: String(intent.quantity),
          note: intent.quantity > 1 ? `${intent.quantity} Tickets` : "Ticket",
          basePriceMoney: { amount: BigInt(event.unit_price!), currency: config.currency },
        },
      ],
      metadata,
      baseUrl,
      email: intent.email,
      phone: intent.phone || undefined,
      label: "Payment link",
    });

    logDebug("Square", result ? `Payment link created orderId=${result.orderId}` : "Payment link creation failed");
    return result;
  },

  /** Create a payment link for multi-event registration */
  createMultiPaymentLink: async (
    intent: MultiRegistrationIntent,
    baseUrl: string,
  ): Promise<PaymentLinkResult> => {
    const config = await getPaymentLinkConfig();
    if (!config) return null;

    logDebug("Square", `Creating multi payment link for ${intent.items.length} events`);

    const metadata = enforceMetadataLimits(buildMultiIntentMetadata(intent));
    if (!metadata) return null;

    const lineItems = map((item: MultiRegistrationIntent["items"][number]) => ({
      name: `Ticket: ${item.name}`,
      quantity: String(item.quantity),
      note: item.quantity > 1 ? `${item.quantity} Tickets` : "Ticket",
      basePriceMoney: { amount: BigInt(item.unitPrice), currency: config.currency },
    }))(intent.items);

    const result = await createPaymentLinkImpl({
      ...config,
      lineItems,
      metadata,
      baseUrl,
      email: intent.email,
      phone: intent.phone || undefined,
      label: "Multi payment link",
    });

    logDebug("Square", result ? `Multi payment link created orderId=${result.orderId}` : "Multi payment link creation failed");
    return result;
  },

  /** Retrieve an order by ID */
  retrieveOrder: (orderId: string): Promise<SquareOrder | null> =>
    withClient(
      async (client) => {
        const response = await client.orders.get({ orderId });
        const order = response.order;
        if (!order) return null;

        // Convert nullable metadata values to plain string record
        const metadata: Record<string, string> | undefined = order.metadata
          ? Object.fromEntries(
              Object.entries(order.metadata).filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === "string",
              ),
            )
          : undefined;

        return {
          id: order.id,
          metadata,
          tenders: order.tenders?.map((t) => ({
            id: t.id,
            paymentId: t.paymentId ?? undefined,
          })),
          state: order.state,
        };
      },
      ErrorCode.SQUARE_ORDER,
    ),

  /** Retrieve a payment by ID */
  retrievePayment: (paymentId: string): Promise<SquarePayment | null> =>
    withClient(
      async (client) => {
        const response = await client.payments.get({ paymentId });
        const payment = response.payment;
        if (!payment) return null;
        return {
          id: payment.id,
          status: payment.status,
          orderId: payment.orderId,
          amountMoney: {
            amount: payment.amountMoney?.amount as bigint | undefined,
            currency: payment.amountMoney?.currency as string | undefined,
          },
        };
      },
      ErrorCode.SQUARE_SESSION,
    ),

  /** Refund a payment (full amount) */
  refundPayment: async (paymentId: string): Promise<boolean> => {
    const payment = await squareApi.retrievePayment(paymentId);
    if (!payment?.amountMoney?.amount || !payment.amountMoney.currency) {
      logError({
        code: ErrorCode.SQUARE_REFUND,
        detail: `Cannot refund payment ${paymentId}: missing amount info`,
      });
      return false;
    }

    const result = await withClient(
      async (client) => {
        await client.refunds.refundPayment({
          idempotencyKey: crypto.randomUUID(),
          paymentId,
          amountMoney: {
            amount: payment.amountMoney!.amount,
            currency: payment.amountMoney!.currency as Square.Currency,
          },
        });
        return true;
      },
      ErrorCode.SQUARE_REFUND,
    );

    return result ?? false;
  },
};

// Wrapper exports for production code (delegate to squareApi for test mocking)
export const getSquareClient = () => squareApi.getSquareClient();
export const resetSquareClient = () => squareApi.resetSquareClient();
export const createPaymentLink = (e: Event, i: RegistrationIntent, b: string) =>
  squareApi.createPaymentLink(e, i, b);
export const createMultiPaymentLink = (i: MultiRegistrationIntent, b: string) =>
  squareApi.createMultiPaymentLink(i, b);
export const retrieveOrder = (id: string) => squareApi.retrieveOrder(id);
export const retrievePayment = (id: string) => squareApi.retrievePayment(id);
export const refundPayment = (id: string) => squareApi.refundPayment(id);

/**
 * =============================================================================
 * Webhook Signature Verification (Web Crypto API for Edge compatibility)
 * =============================================================================
 * Square webhook signature: HMAC-SHA256 of (notification_url + raw_body)
 * using the subscription's signature key. Result is base64-encoded.
 */

/** Compute HMAC-SHA256 and return base64-encoded result (Square format) */
const computeSquareSignature = async (
  data: string,
  secret: string,
): Promise<string> => hmacToBase64(await computeHmacSha256(data, secret));

/**
 * Verify Square webhook signature using Web Crypto API.
 * Square signs: HMAC-SHA256(signature_key, notification_url + raw_body)
 *
 * @param payload - Raw request body as string
 * @param signature - x-square-hmacsha256-signature header value
 * @param notificationUrl - The webhook notification URL registered with Square
 */
export const verifyWebhookSignature = async (
  payload: string,
  signature: string,
  notificationUrl?: string,
): Promise<WebhookVerifyResult> => {
  const secret = await getSquareWebhookSignatureKey();
  if (!secret) {
    logError({ code: ErrorCode.CONFIG_MISSING, detail: "Square webhook signature key" });
    return { valid: false, error: "Webhook signature key not configured" };
  }

  if (!notificationUrl) {
    logError({ code: ErrorCode.SQUARE_SIGNATURE, detail: "notification URL required" });
    return { valid: false, error: "Notification URL required for verification" };
  }

  // Square signs: notification_url + raw_body
  const signedPayload = notificationUrl + payload;
  const expectedSignature = await computeSquareSignature(signedPayload, secret);

  if (!secureCompare(signature, expectedSignature)) {
    logError({ code: ErrorCode.SQUARE_SIGNATURE, detail: "mismatch" });
    return { valid: false, error: "Signature verification failed" };
  }

  try {
    const event = JSON.parse(payload) as WebhookEvent;
    return { valid: true, event };
  } catch {
    logError({ code: ErrorCode.SQUARE_SIGNATURE, detail: "invalid JSON" });
    return { valid: false, error: "Invalid JSON payload" };
  }
};

/**
 * Construct a test webhook event (for testing purposes).
 * Generates a valid Square signature for the given payload.
 * Square signs: notification_url + raw_body (base64-encoded HMAC-SHA256).
 */
export const constructTestWebhookEvent = async (
  event: WebhookEvent,
  secret: string,
  notificationUrl: string,
): Promise<{ payload: string; signature: string }> => {
  const body = JSON.stringify(event);
  const signature = await computeSquareSignature(notificationUrl + body, secret);
  return { payload: body, signature };
};
