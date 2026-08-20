/* jscpd:ignore-start */
import type { ProviderRead } from "#payment/provider-read.ts";
import type { RefundAttemptResult } from "#payment/refund-attempt.ts";
import type { AuthorizedRefundRequest } from "#payment/refund-provider-authorization.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import {
  createSquarePaymentLink,
  type PaymentLinkResult,
} from "#shared/square/checkout.ts";
import {
  getSquareClient,
  resetSquareClient,
  type SquareClient,
} from "#shared/square/client.ts";
import {
  type SquareConnectionTestResult,
  testSquareConnection,
} from "#shared/square/connection.ts";
import { readSquareOrder, type SquareOrder } from "#shared/square/order.ts";
import {
  readSquarePayment,
  refundSquareCharge,
  type SquarePayment,
} from "#shared/square/payment-outcomes.ts";

/* jscpd:ignore-end */

type SquareApi = {
  getSquareClient(): Promise<SquareClient | null>;
  resetSquareClient(): void;
  testSquareConnection(): Promise<SquareConnectionTestResult>;
  createPaymentLink(
    intent: CheckoutIntent,
    baseUrl: string,
  ): Promise<PaymentLinkResult>;
  readOrder(orderId: string): Promise<ProviderRead<SquareOrder>>;
  readPayment(paymentId: string): Promise<ProviderRead<SquarePayment>>;
  refundCharge(
    request: AuthorizedRefundRequest<"square">,
  ): Promise<RefundAttemptResult>;
};

/** The single stubbable seam shared by Square production code and tests. */
export const squareApi: SquareApi = {
  createPaymentLink: (intent, baseUrl) =>
    createSquarePaymentLink(() => squareApi.getSquareClient(), intent, baseUrl),
  getSquareClient,
  readOrder: (orderId) =>
    readSquareOrder(() => squareApi.getSquareClient(), orderId),
  readPayment: (paymentId) =>
    readSquarePayment(() => squareApi.getSquareClient(), paymentId),
  refundCharge: (request) =>
    refundSquareCharge(() => squareApi.getSquareClient(), request),
  resetSquareClient,
  testSquareConnection: () =>
    testSquareConnection(() => squareApi.getSquareClient()),
};
