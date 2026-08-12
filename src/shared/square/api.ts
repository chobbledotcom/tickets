/* jscpd:ignore-start */
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import type {
  RefundAttemptResult,
  RefundRequest,
} from "#shared/payment/refund-attempt.ts";
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
import { retrieveSquareOrder, type SquareOrder } from "#shared/square/order.ts";
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
  retrieveOrder(orderId: string): Promise<SquareOrder | null>;
  readPayment(paymentId: string): Promise<ProviderRead<SquarePayment>>;
  refundCharge(request: RefundRequest): Promise<RefundAttemptResult>;
};

/** The single stubbable seam shared by Square production code and tests. */
export const squareApi: SquareApi = {
  createPaymentLink: (intent, baseUrl) =>
    createSquarePaymentLink(() => squareApi.getSquareClient(), intent, baseUrl),
  getSquareClient,
  readPayment: (paymentId) =>
    readSquarePayment(() => squareApi.getSquareClient(), paymentId),
  refundCharge: (request) =>
    refundSquareCharge(() => squareApi.getSquareClient(), request),
  resetSquareClient,
  retrieveOrder: (orderId) =>
    retrieveSquareOrder(() => squareApi.getSquareClient(), orderId),
  testSquareConnection: () =>
    testSquareConnection(() => squareApi.getSquareClient()),
};
