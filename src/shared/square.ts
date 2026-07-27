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

/* jscpd:ignore-start */
import * as v from "valibot";
import { settings } from "#shared/db/settings.ts";
import { errorMessage } from "#shared/error-message.ts";
import { ErrorCode, type ErrorCodeType, logError } from "#shared/logger.ts";
import type { PaymentCheckoutCreateSnapshot } from "#shared/payment-checkout.ts";
import { cachedClientFactory } from "#shared/payment-helpers.ts";
import { sameMoney } from "#shared/provider-boundary.ts";
import {
  makeProviderTransportReader,
  transportIssueForError,
} from "#shared/provider-transport.ts";
import {
  createSquareCheckout,
  type PaymentLinkResult,
} from "#shared/square-checkout.ts";
import {
  createSquareClient,
  type SquareClient,
  SquareHttpError,
  type SquarePaymentListInput,
  type SquarePaymentPage,
  type SquareRefund,
} from "#shared/square-client.ts";
import type { SquareOrder, SquarePayment } from "#shared/square-payments.ts";

/* jscpd:ignore-end */

type SquareLocation = {
  id?: string;
  name?: string;
  status?: string;
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

export type SquareResourceRead<Value> =
  | { status: "found"; value: Value }
  | { status: "invalid"; reason: "mismatched_id" }
  | { status: "missing" }
  | { status: "unavailable" };

const readSquareTransport = makeProviderTransportReader<
  SquareClient,
  never,
  ErrorCodeType
>({
  classifyError: (error) => {
    if (error instanceof SyntaxError || error instanceof v.ValiError) {
      return "propagate";
    }
    return transportIssueForError(
      error,
      (caught) => caught instanceof SquareHttpError && caught.status === 404,
      "unavailable",
    );
  },
  getClient: () => squareApi.getSquareClient(),
  reportError: (error, code) => logError({ code, detail: errorMessage(error) }),
});

const readSquareResource = <Value>(
  errorCode: ErrorCodeType,
  load: (client: SquareClient) => Promise<Value>,
): Promise<SquareResourceRead<Value>> => readSquareTransport(load, errorCode);

const checkedSquareResource = <Value>(
  read: SquareResourceRead<Value>,
  expectedId: string,
  idOf: (value: Value) => string | undefined,
): SquareResourceRead<Value> =>
  read.status !== "found" || idOf(read.value) === expectedId
    ? read
    : { reason: "mismatched_id", status: "invalid" };

/**
 * Stubbable API for testing - allows mocking in ES modules
 */
export const squareApi: {
  getSquareClient: () => ReturnType<typeof getClientImpl>;
  resetSquareClient: () => void;
  testSquareConnection: () => Promise<SquareConnectionTestResult>;
  createCheckout: (
    checkout: PaymentCheckoutCreateSnapshot,
  ) => Promise<PaymentLinkResult>;
  readOrder: (orderId: string) => Promise<SquareResourceRead<SquareOrder>>;
  readPayment: (
    paymentId: string,
  ) => Promise<SquareResourceRead<SquarePayment>>;
  readPayments: (
    input: SquarePaymentListInput,
  ) => Promise<SquareResourceRead<SquarePaymentPage>>;
  readRefund: (refundId: string) => Promise<SquareResourceRead<SquareRefund>>;
  requestRefund: (
    paymentId: string,
    amount: { amount: number; currency: string },
    idempotencyKey: string,
  ) => Promise<SquareRefund | null>;
} = {
  /** Create a payment link from one prepared checkout. */
  createCheckout: async (
    checkout: PaymentCheckoutCreateSnapshot,
  ): Promise<PaymentLinkResult> =>
    createSquareCheckout(checkout, () => squareApi.getSquareClient()),
  getSquareClient: getClientImpl,

  readOrder: async (orderId): Promise<SquareResourceRead<SquareOrder>> =>
    checkedSquareResource(
      await readSquareResource(
        ErrorCode.SQUARE_ORDER,
        async (client) => (await client.orders.get({ orderId })).order,
      ),
      orderId,
      (order) => order.id,
    ),

  readPayment: async (paymentId): Promise<SquareResourceRead<SquarePayment>> =>
    checkedSquareResource(
      await readSquareResource(
        ErrorCode.SQUARE_SESSION,
        async (client) => (await client.payments.get({ paymentId })).payment,
      ),
      paymentId,
      (payment) => payment.id,
    ),

  readPayments: (input): Promise<SquareResourceRead<SquarePaymentPage>> =>
    readSquareResource(ErrorCode.SQUARE_SESSION, (client) =>
      client.payments.list(input),
    ),

  readRefund: async (refundId): Promise<SquareResourceRead<SquareRefund>> =>
    checkedSquareResource(
      await readSquareResource(ErrorCode.SQUARE_REFUND, (client) =>
        client.refunds.get({ refundId }),
      ),
      refundId,
      (refund) => refund.id,
    ),

  /** Request an exact remaining refund amount. */
  requestRefund: async (paymentId, amount, idempotencyKey) => {
    if (amount.amount <= 0) {
      throw new Error(`Square refund for ${paymentId} must be positive`);
    }
    const client = await squareApi.getSquareClient();
    if (!client) return null;
    let refund: SquareRefund;
    try {
      refund = await client.refunds.requestRefund({
        amountMoney: {
          amount: BigInt(amount.amount),
          currency: amount.currency,
        },
        idempotencyKey,
        paymentId,
      });
    } catch (err) {
      if (err instanceof SyntaxError || err instanceof v.ValiError) throw err;
      logError({
        code: ErrorCode.SQUARE_REFUND,
        detail: errorMessage(err),
      });
      return null;
    }
    if (refund.paymentId !== paymentId) {
      throw new Error(
        `Square refund ${refund.id} is for payment ${refund.paymentId}, not ${paymentId}`,
      );
    }
    if (!sameMoney(refund.amount, amount)) {
      throw new Error(
        `Square refund ${refund.id} amount (${refund.amount.amount} ${refund.amount.currency}) does not match requested amount (${amount.amount} ${amount.currency})`,
      );
    }
    return refund;
  },

  resetSquareClient: (): void => clientCache.reset(),

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
      locations = response.locations === undefined ? [] : response.locations;
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

/** Result of testing the Square connection */
export type SquareConnectionTestResult = {
  ok: boolean;
  accessToken: { valid: boolean; error?: string; mode?: string };
  location: {
    configured: boolean;
    locationId?: string | undefined;
    name?: string | undefined;
    status?: string | undefined;
    error?: string | undefined;
  };
  webhook: { configured: boolean; error?: string };
};
