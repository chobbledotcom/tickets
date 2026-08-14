/** Exact provider money and the owner resolution it can safely support. */

import * as v from "valibot";
import { type Money, MoneySchema, sameMoney } from "#shared/payment/money.ts";
import {
  type ChargeMoney,
  refundMoneyAccountedFor,
  refundMoneyMatchesCapture,
  returnedRefundMoney,
} from "#shared/payment/resources.ts";

const conflictDecision = <const Kind extends "not_sent" | "returned" | "wait">(
  kind: Kind,
) =>
  v.strictObject({
    captured: MoneySchema,
    kind: v.literal(kind),
    refunded: MoneySchema,
  });

const safelyResolved = (decision: {
  readonly captured: Money;
  readonly refunded: Money;
}): boolean =>
  decision.captured.amount > 0 &&
  decision.captured.currency === decision.refunded.currency &&
  decision.refunded.amount <= decision.captured.amount;

const resolvedConflictDecision = <const Kind extends "not_sent" | "returned">(
  kind: Kind,
  returnedAmountIsAllowed: (amount: number) => boolean,
  message: string,
) =>
  v.pipe(
    conflictDecision(kind),
    v.check(
      (decision) =>
        safelyResolved(decision) &&
        returnedAmountIsAllowed(decision.refunded.amount),
      message,
    ),
  );

const NotSentConflictDecisionSchema = resolvedConflictDecision(
  "not_sent",
  (amount) => amount === 0,
  "A not-sent conflict decision must prove no returned money",
);
const ReturnedConflictDecisionSchema = resolvedConflictDecision(
  "returned",
  (amount) => amount > 0,
  "A returned conflict decision must carry exact returned money",
);
const WaitingConflictDecisionSchema = v.pipe(
  conflictDecision("wait"),
  v.check(
    (decision) => decision.captured.amount > 0,
    "A waiting conflict decision must carry captured money",
  ),
);

export const RefundConflictDecisionSchema = v.variant("kind", [
  NotSentConflictDecisionSchema,
  ReturnedConflictDecisionSchema,
  WaitingConflictDecisionSchema,
]);
export type RefundConflictDecision = v.InferOutput<
  typeof RefundConflictDecisionSchema
>;

/** Evidence that cannot yet support an owner decision must be checked again. */
export const refundConflictNeedsProviderCheck = (
  decision: RefundConflictDecision,
): boolean =>
  decision.kind === "wait" ||
  (decision.kind === "returned" &&
    !sameMoney(decision.captured, decision.refunded));

export const ReturnedOrNotSentDecisionSchema = v.strictObject({
  kind: v.literal("returned_or_not_sent"),
});
const RefundOwnerDecisionSchema = v.union([
  ReturnedOrNotSentDecisionSchema,
  RefundConflictDecisionSchema,
]);
export type RefundOwnerDecision = v.InferOutput<
  typeof RefundOwnerDecisionSchema
>;

/** Classify one fresh charge without copying its private provider resources. */
export const refundConflictDecision = (
  known: { readonly captured: Money; readonly refunded: Money },
  charge: ChargeMoney,
): RefundConflictDecision => {
  const valid = refundMoneyMatchesCapture(charge);
  const refunded = valid
    ? returnedRefundMoney(charge)
    : charge.confirmedRefunded;
  const exactMoney = {
    captured: charge.captured,
    refunded,
  };
  if (
    !valid ||
    charge.captured.currency !== known.captured.currency ||
    refunded.currency !== known.refunded.currency ||
    refunded.amount < known.refunded.amount ||
    refundMoneyAccountedFor(charge) !== refunded.amount
  ) {
    return { ...exactMoney, kind: "wait" };
  }
  return refunded.amount === 0
    ? { ...exactMoney, kind: "not_sent" }
    : { ...exactMoney, kind: "returned" };
};
