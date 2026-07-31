import * as v from "valibot";
import type {
  PaymentObservation,
  ProviderRead,
} from "#shared/payment-state/observation.ts";
import type {
  ChargeLeg,
  Money,
  ProviderChargeResource,
  ProviderRefundResource,
  ProviderSessionResource,
  RefundObservation,
} from "#shared/payment-state/resources.ts";

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

export const paymentObservation = (
  values: Partial<PaymentObservation> = {},
): PaymentObservation => ({
  accountId: "acct_1",
  bookingIntent: {
    address: "",
    date: null,
    email: "buyer@example.com",
    items: [{ e: 1, p: 100, q: 1 }],
    modifiers: [],
    name: "Buyer",
    phone: "",
    special_instructions: "",
  },
  charges: [chargeLeg()],
  createdAt: "2026-07-26T12:00:00.000Z",
  expected: { amount: 100, currency: "GBP" },
  mode: "test",
  ownership: {
    localPaymentId: "pay_1",
    method: "signed",
    signature: "signature_1",
  },
  providerTotal: { amount: 100, currency: "GBP" },
  session: sessionResource,
  status: "paid",
  ...values,
});

export const foundRead = (
  observation: PaymentObservation = paymentObservation(),
): Extract<ProviderRead, { status: "found" }> => ({
  observation,
  requested: observation.session,
  returned: observation.session,
  status: "found",
});

export const validationMessage = (
  schema: v.GenericSchema,
  input: unknown,
): string => {
  const result = v.safeParse(schema, input);
  if (result.success) throw new Error("Expected validation to fail");
  return result.issues[0].message;
};
