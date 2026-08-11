import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
import type { Money } from "#shared/payment/money.ts";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import type { RefundAttemptResult } from "#shared/payment/refund-attempt.ts";
import type {
  ChargeMoney,
  ProviderRefundResource,
  RefundObservation,
} from "#shared/payment/resources.ts";

/** Money in the currency these tests use throughout. */
export const gbp = (amount: number): Money => ({ amount, currency: "GBP" });

interface RefundObservationValueBase {
  amount?: Money;
  refund?: ProviderRefundResource;
}

type RefundObservationValues =
  | (RefundObservationValueBase & { status?: "completed" })
  | (RefundObservationValueBase & { status: "pending" })
  | (RefundObservationValueBase & { reason: string; status: "failed" });

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

/** What a provider says about a charge nothing has gone back on — the answer
 *  that lets a refund be sent. Pass `returned` to say some already has. */
export const chargeMoney = (
  captured = 1000,
  returned = 0,
  currency = "GBP",
): ChargeMoney => ({
  captured: { amount: captured, currency },
  confirmedRefunded: { amount: returned, currency },
  refunds: [],
});

/** A charge whose every penny is already back with the buyer. */
export const fullyRefundedMoney = (captured = 1000): ChargeMoney =>
  chargeMoney(captured, captured);

/** The same charge with any part of it replaced, for the money rules' own
 *  tests: they vary the refunds and how much is already back, against a
 *  smaller captured total that keeps the sums easy to read. */
export const chargeMoneyWith = (
  values: Partial<ChargeMoney> = {},
): ChargeMoney => ({
  ...chargeMoney(100),
  ...values,
});

/** A successful explicit read of charge money for provider fakes. */
export const foundCharge = (
  charge: ChargeMoney = chargeMoney(),
): ProviderRead<ChargeMoney> => ({ resource: charge, status: "found" });

/** A provider fake's confirmed full refund of the charge it was handed. */
export const completedRefund = (charge: ChargeMoney): RefundAttemptResult => ({
  amount: charge.captured,
  kind: "completed",
  proof: { charge, kind: "charge_observation" },
});

/** A provider accepted the exact charge refund but has not completed it. */
export const acceptedRefund = (
  charge: ChargeMoney = chargeMoney(),
): RefundAttemptResult => ({
  amount: charge.captured,
  kind: "accepted",
  proof: { charge, kind: "charge_observation" },
});

/** A charge that gave some of the money back but not all of it — what a
 *  "partly refunded" problem is actually made of. */
export const partlyRefundedCharge = (): ChargeMoney =>
  chargeMoneyWith({
    confirmedRefunded: { amount: 40, currency: "GBP" },
    refunds: [refundObservation({ amount: { amount: 40, currency: "GBP" } })],
  });

/** A charge reference as a claim's read carries it: on a row of its own, with
 *  nothing gone back yet. Override any part for a legacy charge, a returned
 *  one, or a charge whose rows are all anchors. */
export const refundReference = (
  reference: string,
  values: Partial<RefundPaymentReference> = {},
): RefundPaymentReference => ({
  heldRowSessionIds: [],
  index: `index_of_${reference}`,
  reference,
  refundState: "none",
  rowSessionIds: [`sess_${reference}`],
  sessionIds: [`sess_${reference}`],
  ...values,
});
