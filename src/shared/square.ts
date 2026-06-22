/**
 * Square integration module for ticket payments
 * Uses direct HTTP calls to the Square REST API (no SDK dependency)
 *
 * Square flow differs from Stripe:
 * - Checkout uses Payment Links (CreatePaymentLink) instead of sessions
 * - Metadata is stored on the Order object
 * - Webhook event is payment.updated (check status === "COMPLETED")
 * - Webhook signature uses HMAC-SHA256 of notification_url + body
 * - Retrieving session data requires fetching the Order by ID
 */

import { priceCheckout } from "#shared/checkout-pricing.ts";
import { settings } from "#shared/db/settings.ts";
import { fetchText } from "#shared/fetch.ts";
import { ErrorCode, logDebug, logError } from "#shared/logger.ts";
import {
  computeHmacSha256,
  hmacToBase64,
  secureCompare,
} from "#shared/payment-crypto.ts";
import {
  buildItemsMetadata,
  buildProviderLineItems,
  cachedClientFactory,
  createWithClient,
  enforceMetadataLimits,
  errorMessage,
  PaymentUserError,
  packMetadata,
  SQUARE_METADATA_MAX_ENTRIES,
  SQUARE_METADATA_MAX_VALUE_LENGTH,
} from "#shared/payment-helpers.ts";
import type {
  CheckoutIntent,
  WebhookEvent,
  WebhookVerifyResult,
} from "#shared/payments.ts";
import { normalizePhone } from "#shared/phone.ts";

/**
 * Square order metadata constraints (from Square API docs):
 * - Max 10 entries per metadata field
 * - Key max 60 characters
 * - Value max 255 characters
 */

/** Raw tender from Square REST API (snake_case) or camelCase from our client */
type SquareRawTender = {
  id?: string;
  payment_id?: string;
  paymentId?: string;
};

/** Extract tender id and paymentId from raw tender data (handles both snake_case and camelCase) */
const mapTender = (t: SquareRawTender) => ({
  id: t.id,
  paymentId: t.paymentId ?? t.payment_id,
});

/** A single line item for Square checkout */
type SquareLineItem = {
  name: string;
  quantity: string;
  note: string;
  basePriceMoney: { amount: bigint; currency: string };
};

/** Input for creating a Square payment link */
export type CreatePaymentLinkInput = {
  idempotencyKey: string;
  order: {
    locationId: string;
    lineItems: SquareLineItem[];
    metadata: Record<string, string>;
  };
  checkoutOptions: { redirectUrl: string };
  prePopulatedData: {
    buyerEmail: string;
    buyerPhoneNumber?: string;
  };
};

/** Input for refunding a Square payment */
export type RefundPaymentInput = {
  idempotencyKey: string;
  paymentId: string;
  amountMoney: { amount: bigint | undefined; currency: string };
};

/** A single error entry from Square's API error response */
type SquareApiErrorEntry = {
  category: string;
  code: string;
  detail?: string;
  field?: string;
};

/** Map Square pre_populated_data fields to user-friendly labels */
const SQUARE_FIELD_LABELS: Record<string, string> = {
  "pre_populated_data.buyer_email": "email address",
  "pre_populated_data.buyer_phone_number": "phone number",
};

/** Parse Square API error entries from an SDK error.
 * The Square SDK error message contains "Status code: N Body: { ... }" */
const parseSquareApiErrors = (err: Error): SquareApiErrorEntry[] | null => {
  const bodyMatch = err.message.match(/Body:\s*(\{[\s\S]*\})\s*$/);
  if (!bodyMatch) return null;
  try {
    const body = JSON.parse(bodyMatch[1]!) as { errors: SquareApiErrorEntry[] };
    return body.errors;
  } catch {
    return null;
  }
};

/** Convert Square INVALID_REQUEST_ERROR entries on user-provided fields
 * to a user-facing message, or null if no user-facing errors found. */
const toUserFacingSquareError = (
  errors: SquareApiErrorEntry[],
): string | null => {
  for (const err of errors) {
    if (err.category !== "INVALID_REQUEST_ERROR" || !err.field) continue;
    const label = SQUARE_FIELD_LABELS[err.field];
    if (label) {
      return `The payment processor rejected the ${label} as invalid. Please correct it and try again.`;
    }
  }
  return null;
};

/** Check if a Square SDK error contains a user-facing validation error.
 * Throws PaymentUserError if so, otherwise re-throws the original error. */
const rethrowAsUserError = (err: unknown): never => {
  if (err instanceof Error) {
    const apiErrors = parseSquareApiErrors(err);
    if (apiErrors) {
      const userMessage = toUserFacingSquareError(apiErrors);
      if (userMessage) throw new PaymentUserError(userMessage);
    }
  }
  throw err;
};

/** Enforce Square's metadata value-length and 10-entry limits via the shared
 * helper, so an over-cap checkout fails with a batching message up front. */
const enforceSquareMetadataLimits = (
  metadata: Record<string, string>,
): Record<string, string> =>
  enforceMetadataLimits(
    metadata,
    SQUARE_METADATA_MAX_VALUE_LENGTH,
    SQUARE_METADATA_MAX_ENTRIES,
  );

/** Square API version for all requests */
const SQUARE_API_VERSION = "2025-01-23";

/** Base URLs for Square environments */
const SQUARE_BASE_URL = {
  production: "https://connect.squareup.com",
  sandbox: "https://connect.squareupsandbox.com",
} as const;

/** JSON.stringify with BigInt → Number conversion for Square money fields */
const jsonStringify = (obj: unknown): string =>
  JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? Number(v) : v));

/** Make an authenticated request to the Square REST API */
const squareFetch = async (
  token: string,
  baseUrl: string,
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<unknown> => {
  const response = await fetchText(`${baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Square-Version": SQUARE_API_VERSION,
    },
    method: options?.method ?? "GET",
    ...(options?.body != null ? { body: jsonStringify(options.body) } : {}),
  });

  if (!response.ok) {
    throw new Error(`Status code: ${response.status} Body: ${response.text}`);
  }

  return JSON.parse(response.text);
};

/** Square REST API response shapes (snake_case) */
type SquarePaymentLinkResponse = {
  payment_link?: {
    order_id?: string;
    url?: string;
    long_url?: string;
  };
};

type SquareOrderResponse = {
  order?: {
    id?: string;
    metadata?: Record<string, string>;
    tenders?: SquareRawTender[];
    state?: string;
    total_money?: { amount: number; currency: string };
    created_at?: string;
  };
};

type SquarePaymentResponse = {
  payment?: {
    id?: string;
    status?: string;
    order_id?: string;
    amount_money?: { amount: number; currency: string };
    refunded_money?: { amount: number; currency: string };
  };
};

type SquareLocation = {
  id?: string;
  name?: string;
  status?: string;
};

type SquareLocationsResponse = {
  locations?: SquareLocation[];
};

/**
 * Create a lightweight Square API client using direct fetch calls.
 * Translates between camelCase (app code) and snake_case (Square REST API).
 * Only implements the 4 endpoints we actually use.
 */
const createSquareClient = (accessToken: string, sandbox: boolean) => {
  const base = sandbox ? SQUARE_BASE_URL.sandbox : SQUARE_BASE_URL.production;

  const post = <T>(path: string, body: unknown) =>
    squareFetch(accessToken, base, path, {
      body,
      method: "POST",
    }) as Promise<T>;
  const get = <T>(path: string) =>
    squareFetch(accessToken, base, path) as Promise<T>;

  return {
    checkout: {
      paymentLinks: {
        create: async (p: CreatePaymentLinkInput) => {
          const data = await post<SquarePaymentLinkResponse>(
            "/v2/online-checkout/payment-links",
            {
              checkout_options: { redirect_url: p.checkoutOptions.redirectUrl },
              idempotency_key: p.idempotencyKey,
              order: {
                line_items: p.order.lineItems.map((i) => ({
                  base_price_money: {
                    amount: i.basePriceMoney.amount,
                    currency: i.basePriceMoney.currency,
                  },
                  name: i.name,
                  note: i.note,
                  quantity: i.quantity,
                })),
                location_id: p.order.locationId,
                metadata: p.order.metadata,
              },
              pre_populated_data: {
                buyer_email: p.prePopulatedData.buyerEmail,
                ...(p.prePopulatedData.buyerPhoneNumber
                  ? { buyer_phone_number: p.prePopulatedData.buyerPhoneNumber }
                  : {}),
              },
            },
          );
          const link = data?.payment_link;
          return {
            paymentLink: link
              ? { orderId: link.order_id, url: link.long_url ?? link.url }
              : undefined,
          };
        },
      },
    },
    locations: {
      list: () => get<SquareLocationsResponse>("/v2/locations"),
    },
    orders: {
      get: async (p: { orderId: string }) => {
        const data = await get<SquareOrderResponse>(
          `/v2/orders/${encodeURIComponent(p.orderId)}`,
        );
        const o = data?.order;
        if (!o) return { order: null };
        return {
          order: {
            createdAt: o.created_at,
            id: o.id,
            metadata: o.metadata,
            state: o.state,
            tenders: o.tenders?.map(mapTender),
            totalMoney: o.total_money
              ? {
                  amount: BigInt(o.total_money.amount),
                  currency: o.total_money.currency,
                }
              : undefined,
          },
        };
      },
    },
    payments: {
      get: async (p: { paymentId: string }) => {
        const data = await get<SquarePaymentResponse>(
          `/v2/payments/${encodeURIComponent(p.paymentId)}`,
        );
        const pm = data?.payment;
        if (!pm) return { payment: null };
        return {
          payment: {
            amountMoney: pm.amount_money
              ? {
                  amount: BigInt(pm.amount_money.amount),
                  currency: pm.amount_money.currency,
                }
              : undefined,
            id: pm.id,
            orderId: pm.order_id,
            refundedMoney: pm.refunded_money
              ? {
                  amount: BigInt(pm.refunded_money.amount),
                  currency: pm.refunded_money.currency,
                }
              : undefined,
            status: pm.status,
          },
        };
      },
    },
    refunds: {
      refundPayment: async (p: RefundPaymentInput) => {
        await post<unknown>("/v2/refunds", {
          amount_money: {
            amount: p.amountMoney.amount,
            currency: p.amountMoney.currency,
          },
          idempotency_key: p.idempotencyKey,
          payment_id: p.paymentId,
        });
        return {};
      },
    },
  };
};

type SquareClientConfig = { accessToken: string; sandbox: boolean };

const clientCache = cachedClientFactory({
  create: ({ accessToken, sandbox }: SquareClientConfig) =>
    createSquareClient(accessToken, sandbox),
  createMessage: ({ sandbox }) =>
    `Creating new Square client (${sandbox ? "sandbox" : "production"})`,
  getConfig: () => {
    const accessToken = settings.square.accessToken;
    if (!accessToken) return null;
    return { accessToken, sandbox: settings.square.sandbox };
  },
  isSameConfig: (a, b) =>
    a.accessToken === b.accessToken && a.sandbox === b.sandbox,
  missingMessage: "No access token configured, cannot create client",
  provider: "Square",
});

/** Internal getSquareClient implementation */
const getClientImpl = (): Promise<SquareClient | null> =>
  clientCache.getClient();

/** Run operation with Square client, return null if not available */
const withClient = createWithClient(() => squareApi.getSquareClient());

/** Get the configured location ID */
const getLocationId = (): string | null => {
  const locationId = settings.square.locationId;
  if (!locationId) {
    logDebug("Square", "No location ID configured");
    return null;
  }
  return locationId;
};

/** Resolved location and currency for payment link creation */
type PaymentLinkConfig = { locationId: string; currency: string };

/** Get location ID and currency, returning null if location is not configured */
const getPaymentLinkConfig = (): PaymentLinkConfig | null => {
  const locationId = getLocationId();
  if (!locationId) return null;
  const currency = settings.currency.toUpperCase();
  return { currency, locationId };
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
  totalMoney: { amount: bigint; currency: string };
  /** Order creation time (RFC 3339 / ISO 8601), from the Square API. */
  createdAt?: string;
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
  refundedMoney?: {
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
  currency: string;
  lineItems: SquareLineItem[];
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
  withClient(async (client) => {
    const response = await client.checkout.paymentLinks
      .create({
        checkoutOptions: {
          redirectUrl: `${params.baseUrl}/payment/success`,
        },
        idempotencyKey: crypto.randomUUID(),
        order: {
          lineItems: params.lineItems,
          locationId: params.locationId,
          metadata: params.metadata,
        },
        prePopulatedData: {
          buyerEmail: params.email,
          ...(params.phone ? { buyerPhoneNumber: params.phone } : {}),
        },
      })
      .catch(rethrowAsUserError);

    const link = response.paymentLink;
    const orderId = link?.orderId;
    const url = link?.url;

    if (!orderId || !url) {
      logDebug("Square", `${params.label} response missing orderId or url`);
      return null;
    }

    return { orderId, url };
  }, ErrorCode.SQUARE_CHECKOUT);

/** Normalize a phone number for Square pre-populated checkout data */
const normalizeCheckoutPhone = (
  phone: string | undefined,
): string | undefined => {
  if (!phone) return undefined;
  return normalizePhone(phone, settings.phonePrefix);
};

type PreparedLink = {
  config: NonNullable<Awaited<ReturnType<typeof getPaymentLinkConfig>>>;
  metadata: Record<string, string>;
};

/** Submit the payment link and log the result. */
const submitPaymentLink = async (
  prep: PreparedLink,
  lineItems: SquareLineItem[],
  intent: { email: string; phone?: string },
  baseUrl: string,
  label: string,
): Promise<PaymentLinkResult> => {
  const result = await createPaymentLinkImpl({
    ...prep.config,
    lineItems,
    ...buildCheckoutOptions(intent, prep.metadata, baseUrl, label),
  });
  logDebug(
    "Square",
    result
      ? `${label} created orderId=${result.orderId}`
      : `${label} creation failed`,
  );
  return result;
};

/** Build common payment link options from intent */
const buildCheckoutOptions = (
  intent: { email: string; phone?: string },
  metadata: Record<string, string>,
  baseUrl: string,
  label: string,
) => ({
  baseUrl,
  email: intent.email,
  label,
  metadata,
  phone: normalizeCheckoutPhone(intent.phone),
});

/** Shared setup for payment link creation: validates config and metadata */
const preparePaymentLink = (
  rawMetadata: Record<string, string>,
  label: string,
): PreparedLink | null => {
  const config = getPaymentLinkConfig();
  if (!config) return null;

  logDebug("Square", `Creating ${label}`);

  const metadata = enforceSquareMetadataLimits(rawMetadata);

  return { config, metadata };
};

/** Type for the Square API client returned by createSquareClient */
export type SquareClient = ReturnType<typeof createSquareClient>;

/**
 * Stubbable API for testing - allows mocking in ES modules
 */
export const squareApi: {
  getSquareClient: () => ReturnType<typeof getClientImpl>;
  resetSquareClient: () => void;
  testSquareConnection: () => Promise<SquareConnectionTestResult>;
  createPaymentLink: (
    intent: CheckoutIntent,
    baseUrl: string,
  ) => Promise<PaymentLinkResult>;
  retrieveOrder: (orderId: string) => Promise<SquareOrder | null>;
  retrievePayment: (paymentId: string) => Promise<SquarePayment | null>;
  refundPayment: (paymentId: string) => Promise<boolean>;
} = {
  /** Create a payment link for one or more listings */
  createPaymentLink: async (
    intent: CheckoutIntent,
    baseUrl: string,
  ): Promise<PaymentLinkResult> => {
    // Price the order once and reuse that total for both the charged line items
    // and the signed proof, so the two can never disagree (see #1300).
    const order = priceCheckout(intent);

    const prep = await preparePaymentLink(
      packMetadata(
        await buildItemsMetadata(
          intent,
          order.total,
          SQUARE_METADATA_MAX_VALUE_LENGTH,
          SQUARE_METADATA_MAX_ENTRIES,
        ),
      ),
      `payment link for ${intent.items.length} listing(s)`,
    );
    if (!prep) return null;

    const lineItems = buildProviderLineItems<SquareLineItem>(
      order,
      prep.config.currency,
      {
        extra: (extra, cur) => ({
          basePriceMoney: { amount: BigInt(extra.amount), currency: cur },
          name: extra.name,
          note: extra.name,
          quantity: String(extra.quantity),
        }),
        line: (line, cur) => ({
          basePriceMoney: {
            amount: BigInt(line.chargedUnitAmount),
            currency: cur,
          },
          name: `Ticket: ${line.item.name}`,
          note: line.quantity > 1 ? `${line.quantity} Tickets` : "Ticket",
          quantity: String(line.quantity),
        }),
      },
    );

    return submitPaymentLink(prep, lineItems, intent, baseUrl, "Payment link");
  },
  getSquareClient: getClientImpl,

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

    const result = await withClient(async (client) => {
      await client.refunds.refundPayment({
        amountMoney: {
          amount: payment.amountMoney!.amount,
          currency: payment.amountMoney!.currency as string,
        },
        idempotencyKey: crypto.randomUUID(),
        paymentId,
      });
      return true;
    }, ErrorCode.SQUARE_REFUND);

    return result ?? false;
  },

  resetSquareClient: (): void => clientCache.reset(),

  /** Retrieve an order by ID */
  retrieveOrder: (orderId: string): Promise<SquareOrder | null> =>
    withClient(async (client) => {
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
        createdAt: order.createdAt,
        id: order.id,
        metadata,
        state: order.state,
        tenders: order.tenders?.map(mapTender),
        totalMoney: {
          amount: order.totalMoney!.amount!,
          currency: order.totalMoney!.currency!,
        },
      };
    }, ErrorCode.SQUARE_ORDER),

  /** Retrieve a payment by ID */
  retrievePayment: (paymentId: string): Promise<SquarePayment | null> =>
    withClient(async (client) => {
      const response = await client.payments.get({ paymentId });
      const payment = response.payment;
      if (!payment) return null;
      return {
        amountMoney: {
          amount: payment.amountMoney?.amount as bigint | undefined,
          currency: payment.amountMoney?.currency as string | undefined,
        },
        id: payment.id,
        orderId: payment.orderId,
        refundedMoney: {
          amount: payment.refundedMoney?.amount as bigint | undefined,
          currency: payment.refundedMoney?.currency as string | undefined,
        },
        status: payment.status,
      };
    }, ErrorCode.SQUARE_SESSION),

  /** Test Square connection: verify access token, location, and webhook key */
  testSquareConnection: async (): Promise<SquareConnectionTestResult> => {
    const result: SquareConnectionTestResult = {
      accessToken: { valid: false },
      location: { configured: false },
      ok: false,
      webhook: { configured: false },
    };

    // Step 1: Test access token by listing locations
    const client = await squareApi.getSquareClient();
    if (!client) {
      result.accessToken.error = "No Square access token configured";
      return result;
    }

    let locations: SquareLocation[] = [];
    try {
      const response = await client.locations.list();
      locations = response.locations ?? [];
      result.accessToken = {
        mode: settings.square.sandbox ? "sandbox" : "production",
        valid: true,
      };
    } catch (err) {
      result.accessToken = { error: errorMessage(err), valid: false };
      return result;
    }

    // Step 2: Verify location ID
    const locationId = settings.square.locationId;
    if (!locationId) {
      result.location = {
        configured: false,
        error: "No location ID configured",
      };
    } else {
      const match = locations.find((l) => l.id === locationId);
      if (match) {
        result.location = {
          configured: true,
          locationId,
          name: match.name,
          status: match.status,
        };
      } else {
        result.location = {
          configured: false,
          error: "Location ID not found in account",
          locationId,
        };
      }
    }

    // Step 3: Check webhook signature key
    const webhookKey = settings.square.webhookSignatureKey;
    result.webhook = { configured: webhookKey !== "" };
    if (!webhookKey) {
      result.webhook.error = "No webhook signature key configured";
    }

    result.ok =
      result.accessToken.valid &&
      result.location.configured &&
      result.webhook.configured;
    return result;
  },
};

// Wrapper exports for production code (delegate to squareApi for test mocking)
export const getSquareClient = () => squareApi.getSquareClient();
export const resetSquareClient = () => squareApi.resetSquareClient();
export const testSquareConnection = () => squareApi.testSquareConnection();
export const createPaymentLink = (i: CheckoutIntent, b: string) =>
  squareApi.createPaymentLink(i, b);
export const retrieveOrder = (id: string) => squareApi.retrieveOrder(id);
export const retrievePayment = (id: string) => squareApi.retrievePayment(id);
export const refundPayment = (id: string) => squareApi.refundPayment(id);

/** Result of testing the Square connection */
export type SquareConnectionTestResult = {
  ok: boolean;
  accessToken: { valid: boolean; error?: string; mode?: string };
  location: {
    configured: boolean;
    locationId?: string;
    name?: string;
    status?: string;
    error?: string;
  };
  webhook: { configured: boolean; error?: string };
};

/**
 * =============================================================================
 * Webhook Signature Verification (Web Crypto API for Edge compatibility)
 * =============================================================================
 * Square webhook signature: HMAC-SHA256 of (notification_url + raw_body)
 * using the subscription's signature key. Result is base64-encoded.
 */

/** Compute HMAC-SHA256 and return base64-encoded result (Square format) */
const computeSquareSignature = async (
  data: Uint8Array,
  secret: string,
): Promise<string> => hmacToBase64(await computeHmacSha256(data, secret));

/** Concatenate notification URL bytes with raw body bytes for HMAC signing */
const buildSignedPayload = (
  notificationUrl: string,
  bodyBytes: Uint8Array,
): Uint8Array => {
  const urlBytes = new TextEncoder().encode(notificationUrl);
  const combined = new Uint8Array(urlBytes.length + bodyBytes.length);
  combined.set(urlBytes);
  combined.set(bodyBytes, urlBytes.length);
  return combined;
};

/**
 * Verify Square webhook signature using Web Crypto API.
 * Square signs: HMAC-SHA256(signature_key, notification_url + raw_body)
 *
 * Uses raw body bytes directly for HMAC computation to avoid a text
 * decoding/encoding round-trip that can alter the payload in CDN edge runtimes.
 *
 * @param payload - Raw request body as string (used for JSON parsing)
 * @param signature - x-square-hmacsha256-signature header value
 * @param notificationUrl - The webhook notification URL registered with Square
 * @param payloadBytes - Raw body bytes from request.arrayBuffer()
 */
export const verifyWebhookSignature = async (
  payload: string,
  signature: string,
  notificationUrl: string,
  payloadBytes: Uint8Array,
): Promise<WebhookVerifyResult> => {
  const secret = settings.square.webhookSignatureKey;
  if (!secret) {
    logError({
      code: ErrorCode.CONFIG_MISSING,
      detail: "Square webhook signature key",
    });
    return { error: "Webhook signature key not configured", valid: false };
  }

  // Square signs: notification_url + raw_body
  const signedData = buildSignedPayload(notificationUrl, payloadBytes);
  const expectedSignature = await computeSquareSignature(signedData, secret);

  if (!secureCompare(signature, expectedSignature)) {
    logError({
      code: ErrorCode.SQUARE_SIGNATURE,
      detail: `mismatch: notificationUrl=${notificationUrl}, receivedLength=${signature.length}, expectedLength=${expectedSignature.length}, receivedPrefix=${signature.slice(
        0,
        8,
      )}..., expectedPrefix=${expectedSignature.slice(
        0,
        8,
      )}..., bodyLength=${payloadBytes.length}`,
    });
    return { error: "Signature verification failed", valid: false };
  }

  try {
    const listing = JSON.parse(payload) as WebhookEvent;
    return { listing, valid: true };
  } catch {
    logError({ code: ErrorCode.SQUARE_SIGNATURE, detail: "invalid JSON" });
    return { error: "Invalid JSON payload", valid: false };
  }
};

/**
 * Construct a test webhook event (for testing purposes).
 * Generates a valid Square signature for the given payload.
 * Square signs: notification_url + raw_body (base64-encoded HMAC-SHA256).
 */
export const constructTestWebhookEvent = async (
  listing: WebhookEvent,
  secret: string,
  notificationUrl: string,
): Promise<{ payload: string; signature: string }> => {
  const body = JSON.stringify(listing);
  const bodyBytes = new TextEncoder().encode(body);
  const signedPayload = buildSignedPayload(notificationUrl, bodyBytes);
  const signature = await computeSquareSignature(signedPayload, secret);
  return { payload: body, signature };
};
