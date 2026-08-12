/* jscpd:ignore-start */
import * as v from "valibot";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { settings } from "#shared/db/settings.ts";
import { ErrorCode, logDebug } from "#shared/logger.ts";
import {
  assembleCheckoutMetadata,
  buildProviderLineItems,
  createWithClient,
  PaymentUserError,
} from "#shared/payment-helpers.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { normalizePhone } from "#shared/phone.ts";
import type {
  CreatePaymentLinkInput,
  GetSquareClient,
} from "#shared/square/client.ts";

/* jscpd:ignore-end */

type SquareLineItem = CreatePaymentLinkInput["order"]["lineItems"][number];

const SquareApiErrorEntrySchema = v.object({
  category: v.string(),
  code: v.string(),
  detail: v.optional(v.string()),
  field: v.optional(v.string()),
});

const SquareApiErrorResponseSchema = v.object({
  errors: v.array(SquareApiErrorEntrySchema),
});

type SquareApiErrorEntry = v.InferOutput<typeof SquareApiErrorEntrySchema>;

const SQUARE_FIELD_LABELS: Record<string, string> = {
  "pre_populated_data.buyer_email": "email address",
  "pre_populated_data.buyer_phone_number": "phone number",
};

const parseSquareApiErrors = (error: Error): SquareApiErrorEntry[] | null => {
  const bodyMatch = error.message.match(/Body:\s*(\{[\s\S]*\})\s*$/);
  const bodyText = bodyMatch?.[1];
  if (!bodyText) return null;
  try {
    const parsed = v.safeParse(
      SquareApiErrorResponseSchema,
      JSON.parse(bodyText),
    );
    return parsed.success ? parsed.output.errors : null;
  } catch {
    // An unreadable body is not a user mistake, so preserve the provider error.
    return null;
  }
};

const toUserFacingSquareError = (
  errors: SquareApiErrorEntry[],
): string | null => {
  for (const error of errors) {
    if (error.category !== "INVALID_REQUEST_ERROR" || !error.field) continue;
    const label = SQUARE_FIELD_LABELS[error.field];
    if (label) {
      return `The payment processor rejected the ${label} as invalid. Please correct it and try again.`;
    }
  }
  return null;
};

const rethrowAsUserError = (error: unknown): never => {
  if (error instanceof Error) {
    const apiErrors = parseSquareApiErrors(error);
    if (apiErrors) {
      const userMessage = toUserFacingSquareError(apiErrors);
      if (userMessage) throw new PaymentUserError(userMessage);
    }
  }
  throw error;
};

type PaymentLinkConfig = { locationId: string; currency: string };

const getPaymentLinkConfig = (): PaymentLinkConfig | null => {
  const locationId = settings.square.locationId;
  if (!locationId) {
    logDebug("Square", "No location ID configured");
    return null;
  }
  return { currency: settings.currency.toUpperCase(), locationId };
};

/** A created Square order and its hosted checkout URL. */
export type PaymentLinkResult = {
  orderId: string;
  url: string;
} | null;

type PaymentLinkParams = PaymentLinkConfig & {
  lineItems: SquareLineItem[];
  metadata: Record<string, string>;
  baseUrl: string;
  email: string;
  phone?: string | undefined;
  label: string;
};

const createPaymentLink = (
  getClient: GetSquareClient,
  params: PaymentLinkParams,
): Promise<PaymentLinkResult> =>
  createWithClient(getClient)(async (client) => {
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

const checkoutPhone = (phone: string | undefined): string | undefined =>
  phone ? normalizePhone(phone, settings.phonePrefix) : undefined;

/** Price an intent once, sign that price, and create its Square payment link. */
export const createSquarePaymentLink = async (
  getClient: GetSquareClient,
  intent: CheckoutIntent,
  baseUrl: string,
): Promise<PaymentLinkResult> => {
  const order = priceCheckout(intent);
  const config = getPaymentLinkConfig();
  if (!config) return null;

  logDebug(
    "Square",
    `Creating payment link for ${intent.items.length} listing(s)`,
  );
  const metadata = await assembleCheckoutMetadata(
    "square",
    intent,
    order.total,
  );
  const lineItems = buildProviderLineItems<SquareLineItem>(
    order,
    config.currency,
    {
      extra: (extra, currency) => ({
        basePriceMoney: { amount: BigInt(extra.amount), currency },
        name: extra.name,
        note: extra.name,
        quantity: String(extra.quantity),
      }),
      line: (line, currency) => ({
        basePriceMoney: {
          amount: BigInt(line.chargedUnitAmount),
          currency,
        },
        name: `Ticket: ${line.item.name}`,
        note: line.quantity > 1 ? `${line.quantity} Tickets` : "Ticket",
        quantity: String(line.quantity),
      }),
    },
  );
  const label = "Payment link";
  const result = await createPaymentLink(getClient, {
    ...config,
    baseUrl,
    email: intent.email,
    label,
    lineItems,
    metadata,
    phone: checkoutPhone(intent.phone),
  });
  logDebug(
    "Square",
    result
      ? `${label} created orderId=${result.orderId}`
      : `${label} creation failed`,
  );
  return result;
};
