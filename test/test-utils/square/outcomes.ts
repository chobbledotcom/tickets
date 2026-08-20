import { assertThrows } from "@std/assert";
import * as v from "valibot";
import type { ProviderRead } from "#payment/provider-read.ts";
import type { SquareOrder } from "#shared/square/order.ts";
import type { SquarePayment } from "#shared/square/payment-outcomes.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";

/** Deliver one completed Square payment webhook to the provider adapter. */
export const completedSquareWebhook = (
  paymentId: string,
  orderId: string,
): ReturnType<typeof squarePaymentProvider.resolveWebhookSession> =>
  squarePaymentProvider.resolveWebhookSession({
    data: {
      object: {
        payment: { id: paymentId, order_id: orderId, status: "COMPLETED" },
      },
    },
    id: `evt_${paymentId}`,
    type: "payment.updated",
  });

/** Wrap an optional Square order in the provider read it represents. */
export const squareOrderRead = (
  order: SquareOrder | null,
): ProviderRead<SquareOrder> =>
  order ? { resource: order, status: "found" } : { status: "missing" };

/** Wrap an optional Square payment in the provider read it represents. */
export const squarePaymentRead = (
  payment: SquarePayment | null,
): ProviderRead<SquarePayment> =>
  payment ? { resource: payment, status: "found" } : { status: "missing" };

/** Produce the boundary error Square adapters receive from malformed data. */
export const squareBoundaryValidationError = (): unknown =>
  assertThrows(() => v.parse(v.string(), 1), v.ValiError);
