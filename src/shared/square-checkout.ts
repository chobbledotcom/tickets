/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import { settings } from "#shared/db/settings.ts";
import { ErrorCode, logDebug } from "#shared/logger.ts";
import type { PaymentCheckoutCreateSnapshot } from "#shared/payment-checkout.ts";
import {
  buildProviderLineItems,
  createWithClient,
  PaymentUserError,
} from "#shared/payment-helpers.ts";
import { ResourceIdSchema } from "#shared/payment-state/resources.ts";
import { normalizePhone } from "#shared/phone.ts";
import type {
  CreatePaymentLinkInput,
  SquareClient,
  SquareLineItem,
} from "#shared/square-client.ts";
import { UrlSchema } from "#shared/validation/string.ts";

/* jscpd:ignore-end */

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
  const body = error.message.match(/Body:\s*(\{[\s\S]*\})\s*$/)?.[1];
  if (body === undefined) return null;
  try {
    return (JSON.parse(body) as { errors: SquareApiErrorEntry[] }).errors;
  } catch {
    return null;
  }
};

const userFacingSquareError = (
  errors: SquareApiErrorEntry[],
): string | null => {
  for (const error of errors) {
    if (error.category !== "INVALID_REQUEST_ERROR" || !error.field) continue;
    const label = SQUARE_FIELD_LABELS[error.field];
    if (label !== undefined) {
      return `The payment processor rejected the ${label} as invalid. Please correct it and try again.`;
    }
  }
  return null;
};

const rethrowAsUserError = (error: unknown): never => {
  if (error instanceof Error) {
    const parsed = parseSquareApiErrors(error);
    const userMessage = parsed === null ? null : userFacingSquareError(parsed);
    if (userMessage !== null) throw new PaymentUserError(userMessage);
  }
  throw error;
};

export type PaymentLinkResult = {
  orderId: string;
  url: string;
} | null;

const PaymentLinkResponseSchema = v.object({
  paymentLink: v.object({
    orderId: ResourceIdSchema,
    url: UrlSchema,
  }),
});

type GetSquareClient = () => Promise<SquareClient | null>;

const createPaymentLink = async (
  input: CreatePaymentLinkInput,
  getClient: GetSquareClient,
): Promise<PaymentLinkResult> => {
  const run = createWithClient(getClient, {
    shouldPropagate: (error) =>
      error instanceof SyntaxError || error instanceof v.ValiError,
  });
  return await run(async (client) => {
    const response = await client.checkout.paymentLinks
      .create(input)
      .catch(rethrowAsUserError);
    const link = v.parse(PaymentLinkResponseSchema, response).paymentLink;
    return { orderId: link.orderId, url: link.url };
  }, ErrorCode.SQUARE_CHECKOUT);
};

const squareLineItems = (
  checkout: PaymentCheckoutCreateSnapshot,
): SquareLineItem[] =>
  buildProviderLineItems<SquareLineItem>(checkout, {
    extra: (extra, currency) => ({
      basePriceMoney: { amount: BigInt(extra.amount), currency },
      name: extra.name,
      note: extra.name,
      quantity: String(extra.quantity),
    }),
    line: (line, currency) => ({
      basePriceMoney: {
        amount: BigInt(line.amount),
        currency,
      },
      name: `Ticket: ${line.name}`,
      note: line.quantity > 1 ? `${line.quantity} Tickets` : "Ticket",
      quantity: String(line.quantity),
    }),
  });

export const createSquareCheckout = async (
  checkout: PaymentCheckoutCreateSnapshot,
  getClient: GetSquareClient,
): Promise<PaymentLinkResult> => {
  const locationId = settings.square.locationId;
  if (locationId === "") {
    logDebug("Square", "No location ID configured");
    return null;
  }
  logDebug(
    "Square",
    `Creating payment link for ${checkout.bookingIntent.items.length} listing(s)`,
  );
  const phone =
    checkout.bookingIntent.phone === ""
      ? undefined
      : normalizePhone(checkout.bookingIntent.phone, settings.phonePrefix);
  const result = await createPaymentLink(
    {
      checkoutOptions: {
        redirectUrl: `${checkout.baseUrl}/payment/success?payment_id=${encodeURIComponent(checkout.localPaymentId)}`,
      },
      idempotencyKey: checkout.localPaymentId,
      order: {
        lineItems: squareLineItems(checkout),
        locationId,
        metadata: checkout.metadata,
      },
      prePopulatedData: {
        buyerEmail: checkout.bookingIntent.email,
        ...(phone === undefined ? {} : { buyerPhoneNumber: phone }),
      },
    },
    getClient,
  );
  logDebug(
    "Square",
    result === null
      ? "Payment link creation failed"
      : `Payment link created orderId=${result.orderId}`,
  );
  return result;
};
