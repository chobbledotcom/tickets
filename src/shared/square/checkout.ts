/* jscpd:ignore-start */

import { settings } from "#db/settings.ts";
import { closedCheckoutErrorFor } from "#payment/checkout-failure.ts";
import {
  ProviderTransportError,
  type RejectedBuyerField,
  rejectedBuyerFieldOf,
} from "#payment/transport-error.ts";
import { priceCheckout } from "#shared/checkout-pricing.ts";
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
import type { SquarePaymentLink } from "#shared/square/wire.ts";

/* jscpd:ignore-end */

type SquareLineItem = CreatePaymentLinkInput["order"]["lineItems"][number];

const SQUARE_FIELD_LABELS: Record<RejectedBuyerField, string> = {
  email: "email address",
  phone: "phone number",
};

const closedSquareError = closedCheckoutErrorFor("square");

/** A rejected buyer field is the one failure the buyer can act on, so it is
 * told to them in their own words before the closed provider facts. */
const rethrowAsUserError = (error: unknown): never => {
  const rejectedField =
    error instanceof ProviderTransportError
      ? rejectedBuyerFieldOf(error)
      : null;
  if (rejectedField === null) throw closedSquareError(error);
  throw new PaymentUserError(
    `The payment processor rejected the ${SQUARE_FIELD_LABELS[rejectedField]} as invalid. Please correct it and try again.`,
  );
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

/** A created Square checkout, or nothing when Square is not configured. */
export type PaymentLinkResult = SquarePaymentLink | null;

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
  createWithClient(getClient, {
    shouldPropagate: () => true,
  })(
    (client) =>
      client.checkout.paymentLinks
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
        .catch(rethrowAsUserError),
    ErrorCode.SQUARE_CHECKOUT,
  );

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
