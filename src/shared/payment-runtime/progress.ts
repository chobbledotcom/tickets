import type {
  PaymentSession,
  PaymentSessionProgress,
} from "#shared/db/payments/types.ts";
import type {
  PaymentResolution,
  PaymentSessionState,
} from "#shared/payment-state/lifecycle.ts";

const PAYMENT_RECONCILE_DELAY_MS = 60_000;

export const paymentProgress = (
  payment: PaymentSession,
  changes: Pick<PaymentSessionProgress, "nextReconcileAt" | "state"> &
    Partial<PaymentSessionProgress>,
): PaymentSessionProgress => {
  const completionState = changes.completionState ?? payment.completionState;
  return {
    attendeeId: payment.attendeeId,
    completion: payment.completion,
    result: payment.result,
    resultState: payment.resultState,
    session: payment.session,
    ticketState: payment.ticketState,
    ticketTokens: payment.ticketTokens,
    ...changes,
    completionState,
    nextReconcileAt:
      completionState === "pending" && changes.nextReconcileAt === null
        ? Date.now()
        : changes.nextReconcileAt,
    state: changes.state,
  };
};

const stateForResolution = (
  resolution: PaymentResolution,
): PaymentSessionState => {
  switch (resolution.status) {
    case "ready":
      return "processing";
    case "pending":
      return "pending";
    case "fully_refunded":
      return "fully_refunded";
    case "retry":
      return "pending";
    case "conflict":
      return "needs_action";
    case "ignore":
      return resolution.reason === "payment_failed" ? "failed" : "pending";
  }
};

export const paymentProgressForResolution = (
  payment: PaymentSession,
  resolution: PaymentResolution,
  observedAt = Date.now(),
): PaymentSessionProgress =>
  paymentProgress(payment, {
    nextReconcileAt:
      resolution.status === "pending" ||
      resolution.status === "retry" ||
      resolution.status === "ready"
        ? observedAt + PAYMENT_RECONCILE_DELAY_MS
        : null,
    result: resolution,
    resultState:
      resolution.status === "conflict" || resolution.status === "retry"
        ? "failed"
        : "succeeded",
    session:
      "observation" in resolution && resolution.observation !== undefined
        ? resolution.observation.session
        : payment.session,
    state: stateForResolution(resolution),
  });
