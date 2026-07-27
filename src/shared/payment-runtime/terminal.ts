import type { PaymentSession } from "#shared/db/payments/types.ts";
import { paymentCompletionResult } from "#shared/payment-completion.ts";
import type {
  PaymentReconcileMode,
  PaymentReconcileOutcome,
} from "#shared/payment-runtime/process.ts";

const outcome = <const Status extends string>(
  payment: PaymentSession,
  status: Status,
) => ({ payment, status });

type TerminalHandler = (
  payment: PaymentSession,
) => PaymentReconcileOutcome | null;

const completedOutcome: TerminalHandler = (payment) => {
  if (payment.completionState !== "completed") {
    throw new Error(`Completed payment ${payment.id} has no completed effects`);
  }
  return payment.attendeeId === null
    ? outcome(payment, "ignore")
    : { ...outcome(payment, "completed"), replayed: true };
};

const fullyRefundedOutcome: TerminalHandler = (payment) =>
  payment.attendeeId !== null &&
  payment.completion?.kind === "placeholder_refund"
    ? {
        ...outcome(payment, "fulfilled"),
        result: paymentCompletionResult(payment),
      }
    : outcome(payment, "fully_refunded");

const conflictOutcome: TerminalHandler = (payment) =>
  outcome(payment, "conflict");
const unfinishedOutcome: TerminalHandler = () => null;

const TERMINAL_HANDLERS: Record<PaymentSession["state"], TerminalHandler> = {
  completed: completedOutcome,
  created: unfinishedOutcome,
  failed: conflictOutcome,
  fully_refunded: fullyRefundedOutcome,
  needs_action: conflictOutcome,
  pending: unfinishedOutcome,
  processing: unfinishedOutcome,
  ready: unfinishedOutcome,
  refunding: unfinishedOutcome,
};

/** Resolve a callback replay without claiming, reading a provider, or running effects. */
export const terminalPaymentOutcome = (
  payment: PaymentSession,
  mode: PaymentReconcileMode,
): PaymentReconcileOutcome | null => {
  if (payment.completionState === "pending" && payment.attendeeId !== null) {
    return mode === "maintenance"
      ? null
      : {
          ...outcome(payment, "fulfilled"),
          result: paymentCompletionResult(payment),
        };
  }
  return TERMINAL_HANDLERS[payment.state](payment);
};
