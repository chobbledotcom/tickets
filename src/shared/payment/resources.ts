import * as v from "valibot";
import { sumOf } from "#fp";
import { type Money, MoneySchema, money } from "#shared/payment/money.ts";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import { ResourceIdSchema } from "#shared/payment/resource-id.ts";
import type { PaymentProviderType } from "#shared/types.ts";

const providerResource = <
  const TProvider extends PaymentProviderType,
  const TKind extends string,
  const TFields extends v.ObjectEntries,
>(
  provider: TProvider,
  kind: TKind,
  fields: TFields,
) =>
  v.strictObject({
    ...fields,
    id: ResourceIdSchema,
    kind: v.literal(kind),
    provider: v.literal(provider),
  });

const ProviderRefundResourceSchema = v.union([
  providerResource("stripe", "stripe_refund", {
    parentId: ResourceIdSchema,
  }),
  providerResource("square", "square_refund", {
    parentId: ResourceIdSchema,
  }),
  providerResource("sumup", "sumup_refund", {
    parentId: ResourceIdSchema,
  }),
]);
export type ProviderRefundResource = v.InferOutput<
  typeof ProviderRefundResourceSchema
>;

/** Money that has to be some actual money. Nothing was never taken, and
 *  nothing is never on its way back. */
const positiveMoney = (message: string) =>
  v.pipe(
    MoneySchema,
    v.check((money) => money.amount > 0, message),
  );

const PositiveMoneySchema = positiveMoney("A paid charge must be positive");

/** A finished or still-going refund must be for some money: a refund of
 *  nothing would read as one still going, for ever. Only a failed refund may
 *  be for nothing, because no money moved at all. */
const MovedRefundMoneySchema = positiveMoney(
  "A refund that moved money must be positive",
);

const refundResult = <
  const TStatus extends string,
  const TRefund extends v.GenericSchema,
  const TFields extends v.ObjectEntries,
>(
  status: TStatus,
  refund: TRefund,
  // An amount given here replaces the default, for the states that demand more
  // of it than simply not being negative.
  fields: TFields,
) =>
  v.strictObject({
    amount: MoneySchema,
    ...fields,
    refund,
    status: v.literal(status),
  });

const optionalRefund = v.optional(ProviderRefundResourceSchema);
const completedRefundResult = refundResult("completed", optionalRefund, {
  amount: MovedRefundMoneySchema,
});
const pendingRefundResult = refundResult("pending", optionalRefund, {
  amount: MovedRefundMoneySchema,
});

const RefundObservationSchema = v.variant("status", [
  completedRefundResult,
  pendingRefundResult,
  refundResult("failed", optionalRefund, { reason: ResourceIdSchema }),
]);
export type RefundObservation = v.InferOutput<typeof RefundObservationSchema>;

const RefundFailureReasonSchema = v.picklist([
  "provider_failed",
  "invalid_amount",
  "multiple_pending_refunds",
  "not_observed",
]);

const RefundResolutionSchema = v.variant("status", [
  completedRefundResult,
  pendingRefundResult,
  refundResult("partial", optionalRefund, { amount: MovedRefundMoneySchema }),
  refundResult("failed", optionalRefund, {
    reason: RefundFailureReasonSchema,
  }),
]);
export type RefundResolution = v.InferOutput<typeof RefundResolutionSchema>;

/**
 * What a provider says about the money on one charge: what it took, what it
 * says has gone back in total, and each refund it names.
 *
 * This is everything the money rules read. A refund asked for against a bare
 * provider reference knows this much and no more — it has no checkout to hang
 * the charge off — so the rules take these facts rather than a whole leg.
 */
const ChargeMoneySchema = v.strictObject({
  captured: PositiveMoneySchema,
  confirmedRefunded: MoneySchema,
  refunds: v.array(RefundObservationSchema),
});
export type ChargeMoney = v.InferOutput<typeof ChargeMoneySchema>;

/**
 * The money a provider states about one charge. An amount that will not parse,
 * a missing currency, or a charge that took nothing is named as invalid. This
 * is the one door provider numbers come through, so no adapter invents money.
 */
export const chargeMoneyRead = (
  capturedAmount: unknown,
  currency: unknown,
  refundedAmount: unknown,
  refunds: RefundObservation[] = [],
): ProviderRead<ChargeMoney> => {
  const captured = money(capturedAmount, currency);
  const confirmedRefunded = money(refundedAmount, currency);
  if (captured === null || confirmedRefunded === null) {
    return { reason: "malformed_money", status: "invalid" };
  }
  const parsed = v.safeParse(ChargeMoneySchema, {
    captured,
    confirmedRefunded,
    refunds,
  });
  return parsed.success
    ? { resource: parsed.output, status: "found" }
    : { reason: "malformed_money", status: "invalid" };
};

/** Adds up the refunds at one point in their life — every one still going, or
 *  every one finished. */
const refundMoneyThatIs =
  (status: RefundObservation["status"]) =>
  (charge: ChargeMoney): number =>
    sumOf((refund: RefundObservation) => refund.amount.amount)(
      charge.refunds.filter((refund) => refund.status === status),
    );

const refundMoneyStillGoing = refundMoneyThatIs("pending");
const refundMoneyGivenBack = refundMoneyThatIs("completed");

/**
 * Compares money given back with money taken. Two currencies cannot be
 * compared at all, so that is checked here once; which refunds count, and how
 * the two totals must compare, is the caller's to say.
 */
const comparedWithMoneyTaken =
  (
    moneyBack: (charge: ChargeMoney) => number,
    holds: (back: number, taken: number) => boolean,
  ) =>
  (charge: ChargeMoney): boolean =>
    charge.confirmedRefunded.currency === charge.captured.currency &&
    holds(moneyBack(charge), charge.captured.amount);

/**
 * Money already back with the buyer. The cumulative total is meant to hold
 * every refund the provider says it finished, so adding both would count those
 * twice — but the total can also lag behind one it has not caught up with, so
 * whichever is larger is what actually went back. The single answer to "how
 * much came back": no caller can reach a different one and read a finished
 * refund as no refund at all.
 */
export const refundMoneyReturned = (charge: ChargeMoney): number =>
  Math.max(charge.confirmedRefunded.amount, refundMoneyGivenBack(charge));

/** The exact returned total in the charge's captured currency. */
export const returnedRefundMoney = (charge: ChargeMoney): Money => ({
  amount: refundMoneyReturned(charge),
  currency: charge.captured.currency,
});

/** Everything back or on its way, counted once — money still going is
 *  genuinely on top of the money already returned. */
export const refundMoneyAccountedFor = (charge: ChargeMoney): number =>
  refundMoneyReturned(charge) + refundMoneyStillGoing(charge);

/** Nothing given back, or still on its way, comes to more than was taken. */
const refundFitsWithinCapture = comparedWithMoneyTaken(
  refundMoneyAccountedFor,
  (back, taken) => back <= taken,
);

export const refundMoneyMatchesCapture = (charge: ChargeMoney): boolean =>
  refundFitsWithinCapture(charge) &&
  charge.refunds.every(
    (refund) =>
      refund.amount.currency === charge.captured.currency &&
      refund.amount.amount <= charge.captured.amount,
  );
