/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import { makeProviderCheckout } from "#shared/payment-helpers.ts";
import { PAYMENT_PROVIDER_RESOURCES } from "#shared/payment-runtime/current.ts";
import {
  ignoredProviderNotice,
  invalidProviderNotice,
  parseVerifiedProviderNotice,
  providerNotice,
} from "#shared/payment-runtime/provider-notice.ts";
import { ResourceIdSchema } from "#shared/payment-state/resources.ts";
import type { PaymentProvider, WebhookSetupResult } from "#shared/payments.ts";
import { squareApi } from "#shared/square.ts";
import { SquarePaymentStatusSchema } from "#shared/square-client.ts";
import { readSquarePayment } from "#shared/square-provider-read.ts";
import { refundSquareCharge } from "#shared/square-refunds.ts";
import { verifySquareWebhookSignature } from "#shared/square-webhook.ts";

/* jscpd:ignore-end */

const SquareNoticePaymentSchema = v.object({
  id: ResourceIdSchema,
  order_id: ResourceIdSchema,
  status: SquarePaymentStatusSchema,
});

const SquareNoticeSchema = v.object({
  data: v.object({
    object: v.union([
      v.object({ payment: SquareNoticePaymentSchema }),
      SquareNoticePaymentSchema,
    ]),
  }),
  event_id: v.optional(ResourceIdSchema),
  id: v.optional(ResourceIdSchema),
  type: v.string(),
});

const squareResources = PAYMENT_PROVIDER_RESOURCES.square;

const createCheckout = makeProviderCheckout(
  "Square",
  (checkout) => squareApi.createCheckout(checkout),
  (link) => ({
    session: link === null ? undefined : squareResources.session(link.orderId),
    sessionId: link?.orderId,
    url: link?.url,
  }),
);

const verifySquareNotice: PaymentProvider["verifyWebhookSignature"] = async (
  payload,
  signature,
  webhookUrl,
  payloadBytes,
) => {
  const verified = await verifySquareWebhookSignature(
    payload,
    signature,
    webhookUrl,
    payloadBytes,
  );
  return parseVerifiedProviderNotice(verified, SquareNoticeSchema, (event) => {
    if (event.type !== "payment.updated") return ignoredProviderNotice();
    const object = event.data.object;
    const payment = "payment" in object ? object.payment : object;
    const eventId = event.event_id ?? event.id;
    return eventId === undefined
      ? invalidProviderNotice("Square webhook is missing event id")
      : providerNotice(
          eventId,
          squareResources.charge(payment.id, payment.order_id),
          event.type,
        );
  });
};

export const squarePaymentProvider: PaymentProvider = {
  createCheckout,
  readPayment: readSquarePayment,
  refundCharge: refundSquareCharge,
  requiresWebhookSignature: true,
  setupWebhookEndpoint(
    _secretKey: string,
    _webhookUrl: string,
    _existingEndpointId?: string | null,
  ): Promise<WebhookSetupResult> {
    return Promise.resolve({
      error:
        "Square webhooks must be configured manually in the Square Developer Dashboard",
      success: false,
    });
  },
  type: "square",
  verifyWebhookSignature: verifySquareNotice,
};
