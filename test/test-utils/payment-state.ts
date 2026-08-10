import * as v from "valibot";
import type { Money } from "#shared/payment/money.ts";
import type {
  ChargeLeg,
  ProviderChargeResource,
  ProviderRefundResource,
  ProviderSessionResource,
  RefundObservation,
} from "#shared/payment/resources.ts";

interface RefundObservationValueBase {
  amount?: Money;
  refund?: ProviderRefundResource;
}

type RefundObservationValues =
  | (RefundObservationValueBase & { status?: "completed" })
  | (RefundObservationValueBase & { status: "pending" })
  | (RefundObservationValueBase & { reason: string; status: "failed" });

export const sessionResource: ProviderSessionResource = {
  id: "cs_1",
  kind: "stripe_checkout_session",
  provider: "stripe",
};

export const chargeResource: ProviderChargeResource = {
  id: "pi_1",
  kind: "stripe_payment_intent",
  parentId: "cs_1",
  provider: "stripe",
};

export const refundResource: ProviderRefundResource = {
  id: "re_1",
  kind: "stripe_refund",
  parentId: "pi_1",
  provider: "stripe",
};

export const refundObservation = (
  values: RefundObservationValues = {},
): RefundObservation => {
  const amount = values.amount ?? { amount: 100, currency: "GBP" };
  const refund = values.refund ?? refundResource;
  if (values.status === "pending") {
    return { amount, refund, status: "pending" };
  }
  if (values.status === "failed") {
    return {
      amount,
      reason: values.reason,
      refund,
      status: "failed",
    };
  }
  return { amount, refund, status: "completed" };
};

export const chargeLeg = (values: Partial<ChargeLeg> = {}): ChargeLeg => ({
  captured: { amount: 100, currency: "GBP" },
  confirmedRefunded: { amount: 0, currency: "GBP" },
  refunds: [],
  resource: chargeResource,
  ...values,
});

/** A charge that gave some of the money back but not all of it — what a
 *  "partly refunded" problem is actually made of. */
export const partlyRefundedCharge = (): ChargeLeg =>
  chargeLeg({
    confirmedRefunded: { amount: 40, currency: "GBP" },
    refunds: [refundObservation({ amount: { amount: 40, currency: "GBP" } })],
  });

export const validationMessage = (
  schema: v.GenericSchema,
  input: unknown,
): string => {
  const result = v.safeParse(schema, input);
  if (result.success) throw new Error("Expected validation to fail");
  return result.issues[0].message;
};
