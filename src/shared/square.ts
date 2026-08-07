import { priceCheckout } from "#shared/checkout-pricing.ts";
import { settings } from "#shared/db/settings.ts";
import { errorMessage } from "#shared/error-message.ts";
import { ErrorCode, logDebug } from "#shared/logger.ts";
import {
  assembleCheckoutMetadata,
  buildProviderLineItems,
  cachedClientFactory,
  createWithClient,
  PaymentUserError,
} from "#shared/payment-helpers.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { normalizePhone } from "#shared/phone.ts";
import {
  createSquareClient,
  type SquareClient,
  type SquareLineItem,
  type SquareLocation,
} from "#shared/square/client.ts";
import {
  createSquareOperations,
  type SquareOperations,
} from "#shared/square/operations.ts";

type SquareApiErrorEntry = {
  category: string;
  code: string;
  detail?: string;
  field?: string;
};

const SQUARE_FIELD_LABELS: Record<string, string> = {
  "pre_populated_data.buyer_email": "email address",
  "pre_populated_data.buyer_phone_number": "phone number",
};

const parseSquareApiErrors = (error: Error): SquareApiErrorEntry[] | null => {
  const bodyMatch = error.message.match(/Body:\s*(\{[\s\S]*\})\s*$/);
  if (!bodyMatch) return null;
  try {
    const body = JSON.parse(bodyMatch[1]!) as { errors: SquareApiErrorEntry[] };
    return body.errors;
  } catch {
    return null;
  }
};

const rethrowAsUserError = (error: unknown): never => {
  if (error instanceof Error) {
    const apiErrors = parseSquareApiErrors(error);
    const userError = apiErrors?.find(
      (item) =>
        item.category === "INVALID_REQUEST_ERROR" &&
        item.field !== undefined &&
        SQUARE_FIELD_LABELS[item.field] !== undefined,
    );
    if (userError?.field) {
      throw new PaymentUserError(
        `The payment processor rejected the ${
          SQUARE_FIELD_LABELS[userError.field]
        } as invalid. Please correct it and try again.`,
      );
    }
  }
  throw error;
};

type SquareClientConfig = { accessToken: string; sandbox: boolean };

const clientCache = cachedClientFactory({
  create: ({ accessToken, sandbox }: SquareClientConfig) =>
    createSquareClient(accessToken, sandbox),
  createMessage: ({ sandbox }) =>
    `Creating new Square client (${sandbox ? "sandbox" : "production"})`,
  getConfig: () => {
    const accessToken = settings.square.accessToken;
    return accessToken
      ? { accessToken, sandbox: settings.square.sandbox }
      : null;
  },
  isSameConfig: (left, right) =>
    left.accessToken === right.accessToken && left.sandbox === right.sandbox,
  missingMessage: "No access token configured, cannot create client",
  provider: "Square",
});

export type PaymentLinkResult = {
  orderId: string;
  url: string;
} | null;

type PaymentLinkParams = {
  locationId: string;
  currency: string;
  lineItems: SquareLineItem[];
  metadata: Record<string, string>;
  baseUrl: string;
  email: string;
  phone?: string | undefined;
  label: string;
};

export type SquareConnectionTestResult = {
  ok: boolean;
  accessToken: { valid: boolean; error?: string; mode?: string };
  location: {
    configured: boolean;
    locationId?: string;
    name?: string | undefined;
    status?: string | undefined;
    error?: string;
  };
  webhook: { configured: boolean; error?: string };
};

interface SquareApi extends SquareOperations {
  createPaymentLink(
    intent: CheckoutIntent,
    baseUrl: string,
  ): Promise<PaymentLinkResult>;
  getSquareClient(): Promise<SquareClient | null>;
  resetSquareClient(): void;
  testSquareConnection(): Promise<SquareConnectionTestResult>;
}

const createPaymentLink = (
  params: PaymentLinkParams,
): Promise<PaymentLinkResult> =>
  createWithClient(() => squareApi.getSquareClient())(async (client) => {
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
    const orderId = response.paymentLink?.orderId;
    const url = response.paymentLink?.url;
    if (!orderId || !url) {
      logDebug("Square", `${params.label} response missing orderId or url`);
      return null;
    }
    return { orderId, url };
  }, ErrorCode.SQUARE_CHECKOUT);

const normalizeCheckoutPhone = (phone: string | undefined) =>
  phone ? normalizePhone(phone, settings.phonePrefix) : undefined;

const createCheckoutPaymentLink = async (
  intent: CheckoutIntent,
  baseUrl: string,
): Promise<PaymentLinkResult> => {
  const order = priceCheckout(intent);
  const locationId = settings.square.locationId;
  if (!locationId) {
    logDebug("Square", "No location ID configured");
    return null;
  }
  const currency = settings.currency.toUpperCase();
  logDebug(
    "Square",
    `Creating payment link for ${intent.items.length} listing(s)`,
  );
  const metadata = await assembleCheckoutMetadata(
    "square",
    intent,
    order.total,
  );
  const lineItems = buildProviderLineItems<SquareLineItem>(order, currency, {
    extra: (extra, currentCurrency) => ({
      basePriceMoney: {
        amount: BigInt(extra.amount),
        currency: currentCurrency,
      },
      name: extra.name,
      note: extra.name,
      quantity: String(extra.quantity),
    }),
    line: (line, currentCurrency) => ({
      basePriceMoney: {
        amount: BigInt(line.chargedUnitAmount),
        currency: currentCurrency,
      },
      name: `Ticket: ${line.item.name}`,
      note: line.quantity > 1 ? `${line.quantity} Tickets` : "Ticket",
      quantity: String(line.quantity),
    }),
  });
  const result = await createPaymentLink({
    baseUrl,
    currency,
    email: intent.email,
    label: "Payment link",
    lineItems,
    locationId,
    metadata,
    phone: normalizeCheckoutPhone(intent.phone),
  });
  logDebug(
    "Square",
    result
      ? `Payment link created orderId=${result.orderId}`
      : "Payment link creation failed",
  );
  return result;
};

const testSquareConnection = async (): Promise<SquareConnectionTestResult> => {
  const result: SquareConnectionTestResult = {
    accessToken: { valid: false },
    location: { configured: false },
    ok: false,
    webhook: { configured: false },
  };
  const client = await squareApi.getSquareClient();
  if (!client) {
    result.accessToken.error = "No Square access token configured";
    return result;
  }

  let locations: SquareLocation[];
  try {
    const response = await client.locations.list();
    locations = response.locations ?? [];
    result.accessToken = {
      mode: settings.square.sandbox ? "sandbox" : "production",
      valid: true,
    };
  } catch (error) {
    result.accessToken = { error: errorMessage(error), valid: false };
    return result;
  }

  const locationId = settings.square.locationId;
  const location = locations.find((item) => item.id === locationId);
  result.location = !locationId
    ? { configured: false, error: "No location ID configured" }
    : location
      ? {
          configured: true,
          locationId,
          name: location.name,
          status: location.status,
        }
      : {
          configured: false,
          error: "Location ID not found in account",
          locationId,
        };

  const webhookKey = settings.square.webhookSignatureKey;
  result.webhook = webhookKey
    ? { configured: true }
    : {
        configured: false,
        error: "No webhook signature key configured",
      };
  result.ok =
    result.accessToken.valid &&
    result.location.configured &&
    result.webhook.configured;
  return result;
};

export const squareApi: SquareApi = {
  ...createSquareOperations(
    () => squareApi.getSquareClient(),
    () => squareApi,
  ),
  createPaymentLink: createCheckoutPaymentLink,
  getSquareClient: () => clientCache.getClient(),
  resetSquareClient: () => clientCache.reset(),
  testSquareConnection,
};
