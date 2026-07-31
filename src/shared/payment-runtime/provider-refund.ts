import * as v from "valibot";
import type { PaymentCharge } from "#shared/db/payments/types.ts";
import type {
  Money,
  ProviderRefundResource,
  RefundResolution,
} from "#shared/payment-state/resources.ts";
import { RefundResolutionSchema } from "#shared/payment-state/resources.ts";
import type { PaymentProvider } from "#shared/payments.ts";

const providerRefund = (
  status: "completed" | "partial" | "pending",
  amount: Money,
  refund: ProviderRefundResource | null,
): RefundResolution =>
  v.parse(RefundResolutionSchema, {
    amount,
    ...(refund === null ? {} : { refund }),
    status,
  });

export const completedProviderRefund = (
  charge: PaymentCharge,
  refund: ProviderRefundResource | null,
): RefundResolution => providerRefund("completed", charge.captured, refund);

export const pendingProviderRefund = (
  charge: PaymentCharge,
  refund: ProviderRefundResource | null,
): RefundResolution => providerRefund("pending", charge.captured, refund);

export const partialProviderRefund = (
  amount: Money,
  refund: ProviderRefundResource | null,
): RefundResolution => providerRefund("partial", amount, refund);

export const failedProviderRefund = (
  charge: PaymentCharge,
  refund: ProviderRefundResource | null = null,
): RefundResolution =>
  v.parse(RefundResolutionSchema, {
    amount: charge.refunded,
    reason: "provider_failed",
    ...(refund === null ? {} : { refund }),
    status: "failed",
  });

export const makeProviderRefund =
  (
    observePending: (charge: PaymentCharge) => Promise<RefundResolution>,
    requestNew: PaymentProvider["refundCharge"],
  ): PaymentProvider["refundCharge"] =>
  async (charge, idempotencyKey) =>
    charge.refundState === "pending"
      ? observePending(charge)
      : requestNew(charge, idempotencyKey);

export const makeProviderRefundRequest =
  <Result>(
    request: (
      reference: string,
      idempotencyKey: string,
    ) => Promise<Result | null>,
    resolve: (charge: PaymentCharge, result: Result) => RefundResolution,
  ): PaymentProvider["refundCharge"] =>
  async (charge, idempotencyKey) => {
    const result = await request(charge.providerReference.id, idempotencyKey);
    return result === null
      ? failedProviderRefund(charge)
      : resolve(charge, result);
  };
