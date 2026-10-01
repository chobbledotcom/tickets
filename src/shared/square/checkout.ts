/* jscpd:ignore-start */

import { settings } from "#db/settings.ts";
import { stageSquareLinkEnd } from "#db/square-link-ends.ts";
import { closedCheckoutErrorFor } from "#payment/checkout-failure.ts";
import { providerLineCopy } from "#payment/provider-line-copy.ts";
import {
  ProviderTransportError,
  type RejectedBuyerField,
  rejectedBuyerFieldOf,
} from "#payment/transport-error.ts";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { xCount } from "#shared/count-text.ts";
import { CHECKOUT_WINDOW_MS } from "#shared/limits.ts";
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
import {
  epochMsToIso,
  instantToEpochMs,
} from "#shared/validation/timestamp.ts";

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

/** When a Square checkout link stops taking payment: creation plus the
 * shared checkout window. The link actually dies only when the expiry task
 * ends it, or when its first payment lands. */
export const squareLinkEndsAt = (createdAt: string): string =>
  epochMsToIso(instantToEpochMs(createdAt) + CHECKOUT_WINDOW_MS);

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
    `Creating payment link for ${xCount(intent.items.length)} listings`,
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
      line: (line, currency) => {
        const copy = providerLineCopy(line.item, line.quantity);
        return {
          basePriceMoney: {
            amount: BigInt(line.chargedUnitAmount),
            currency,
          },
          name: copy.name,
          note: copy.description,
          quantity: String(line.quantity),
        };
      },
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
  if (result) {
    // The handle is Square's alone to need: only a Square link outlives its
    // checkout window unless somebody ends it, so only Square's create stages
    // one. The first attempt lands exactly at the window, so no claim can end
    // a link the buyer can still pay.
    await stageSquareLinkEnd(
      result.orderId,
      result.linkId,
      squareLinkEndsAt(result.createdAt),
    );
  }
  logDebug(
    "Square",
    result
      ? `${label} created orderId=${result.orderId}`
      : `${label} creation failed`,
  );
  return result;
};
