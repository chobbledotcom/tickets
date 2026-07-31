/* jscpd:ignore-start -- imports */
import type { PaymentResult, PaymentWork } from "#routes/api/webhook-types.ts";
import { requireBulkRefundAction } from "#shared/db/payments/bulk-refunds.ts";
import {
  claimNextPaymentCaseAlert,
  markPaymentCaseAlertSent,
  releasePaymentCaseAlert,
} from "#shared/db/payments/case-alerts.ts";
import {
  type DuePaymentDecision,
  getDuePaymentDecisions,
  PAYMENT_DECISION_PAGE_SIZE,
} from "#shared/db/payments/decision-attempts.ts";
import {
  type DuePaymentSession,
  getDuePaymentSessionsPrimary,
  PAYMENT_RECONCILIATION_PAGE_SIZE,
} from "#shared/db/payments/due.ts";
import type { MaintenanceTaskContext } from "#shared/maintenance/definition.ts";
import { sendNtfyError } from "#shared/ntfy.ts";
import { finishQueuedBulkRefund } from "#shared/payment-runtime/bulk-refund.ts";
import {
  PAYMENT_CASE_ALERT_ITEM_BUDGET,
  PAYMENT_CASE_ALERT_TASK_BUDGET,
  PAYMENT_DECISION_ITEM_BUDGET,
  PAYMENT_RECONCILIATION_ITEM_BUDGET,
} from "#shared/payment-runtime/maintenance-budget.ts";
import type {
  PaymentReconcileMode,
  PaymentReconcileOutcome,
} from "#shared/payment-runtime/process.ts";
import type { SubrequestCounts } from "#shared/subrequest-budget.ts";
import type { PaymentProviderType } from "#shared/types.ts";

/* jscpd:ignore-end */

const PAYMENT_CASE_ALERT_PAGE_SIZE = PAYMENT_CASE_ALERT_TASK_BUDGET.external;
const PAYMENT_WORK_LEASE_MS = 5 * 60 * 1_000;

type LocalPaymentLocator = { id: string; kind: "local" };
type MaintenanceFulfilPayment = (work: PaymentWork) => Promise<PaymentResult>;

export interface PaymentMaintenanceActions {
  fulfil: MaintenanceFulfilPayment;
  reconcile: (
    provider: PaymentProviderType,
    locator: LocalPaymentLocator,
    fulfil: MaintenanceFulfilPayment,
    mode: PaymentReconcileMode,
  ) => Promise<PaymentReconcileOutcome | undefined>;
  resumeCheckout: (paymentId: string) => Promise<unknown>;
}

export interface PaymentDecisionMaintenanceActions {
  fulfil: MaintenanceFulfilPayment;
  resume: (
    decisionId: number,
    fulfil: MaintenanceFulfilPayment,
  ) => Promise<unknown>;
}

const loadPaymentMaintenanceActions =
  async (): Promise<PaymentMaintenanceActions> => {
    const [create, process, fulfilment] = await Promise.all([
      import("#shared/payment-runtime/create.ts"),
      import("#shared/payment-runtime/process.ts"),
      import("#routes/api/payment-processing/index.ts"),
    ]);
    return {
      fulfil: fulfilment.fulfilPayment,
      reconcile: process.reconcilePayment,
      resumeCheckout: create.resumePaymentCheckout,
    };
  };

const loadPaymentDecisionMaintenanceActions =
  async (): Promise<PaymentDecisionMaintenanceActions> => {
    const [operator, fulfilment] = await Promise.all([
      import("#shared/payment-runtime/operator.ts"),
      import("#routes/api/payment-processing/index.ts"),
    ]);
    return {
      fulfil: fulfilment.fulfilPayment,
      resume: operator.resumePaymentDecision,
    };
  };

const reconcileDuePayment = async (
  payment: DuePaymentSession,
  actions: PaymentMaintenanceActions,
): Promise<PaymentReconcileOutcome | undefined> =>
  await actions.reconcile(
    payment.provider,
    { id: payment.id, kind: "local" },
    actions.fulfil,
    "maintenance",
  );

const DUE_PAYMENT_HANDLERS: Record<
  DuePaymentSession["state"],
  (
    payment: DuePaymentSession,
    actions: PaymentMaintenanceActions,
  ) => Promise<PaymentReconcileOutcome | undefined>
> = {
  completed: reconcileDuePayment,
  created: async (payment, actions): Promise<undefined> => {
    await actions.resumeCheckout(payment.id);
    return;
  },
  fully_refunded: reconcileDuePayment,
  pending: reconcileDuePayment,
  processing: reconcileDuePayment,
  ready: reconcileDuePayment,
  refunding: reconcileDuePayment,
};

export const processDuePaymentSession = async (
  payment: DuePaymentSession,
  actions: PaymentMaintenanceActions,
): Promise<void> => {
  const outcome = await DUE_PAYMENT_HANDLERS[payment.state](payment, actions);
  if (!payment.bulkRefund || outcome === undefined) {
    return;
  }
  const stored = outcome.payment;
  if (stored === null || !("bookingIntent" in stored)) {
    throw new Error(`Bulk refund ${payment.id} lost its payment aggregate`);
  }
  if (stored.state === "needs_action") {
    await requireBulkRefundAction(stored);
  } else if (outcome.status === "fully_refunded") {
    await finishQueuedBulkRefund(stored);
  }
};

const itemFits = (
  context: MaintenanceTaskContext,
  required: SubrequestCounts,
): boolean => {
  if (Date.now() >= context.deadline) return false;
  const remaining = context.budget.remaining();
  return (
    remaining.database >= required.database &&
    remaining.external >= required.external &&
    remaining.total >= required.total
  );
};

export const runPaymentReconciliationMaintenance = async (
  context: MaintenanceTaskContext,
  providedActions?: PaymentMaintenanceActions,
): Promise<void> => {
  const due = await getDuePaymentSessionsPrimary();
  let stopped = false;
  let actions = providedActions;
  for (const payment of due) {
    if (!itemFits(context, PAYMENT_RECONCILIATION_ITEM_BUDGET)) {
      stopped = true;
      break;
    }
    actions ??= await loadPaymentMaintenanceActions();
    await processDuePaymentSession(payment, actions);
  }
  if (stopped || due.length === PAYMENT_RECONCILIATION_PAGE_SIZE) {
    context.requestFollowUp();
  }
};

export const processDuePaymentDecision = (
  decision: DuePaymentDecision,
  actions: PaymentDecisionMaintenanceActions,
): Promise<unknown> => actions.resume(decision.id, actions.fulfil);

export const runPaymentDecisionMaintenance = async (
  context: MaintenanceTaskContext,
  providedActions?: PaymentDecisionMaintenanceActions,
): Promise<void> => {
  const due = await getDuePaymentDecisions();
  let stopped = false;
  let actions = providedActions;
  for (const decision of due) {
    if (!itemFits(context, PAYMENT_DECISION_ITEM_BUDGET)) {
      stopped = true;
      break;
    }
    actions ??= await loadPaymentDecisionMaintenanceActions();
    await processDuePaymentDecision(decision, actions);
  }
  if (stopped || due.length === PAYMENT_DECISION_PAGE_SIZE) {
    context.requestFollowUp();
  }
};

/** Run owner decisions and ordinary reconciliation in one scheduled worker so
 * two payment writers never compete with each other. */
export const runPaymentMaintenance = async (
  context: MaintenanceTaskContext,
): Promise<void> => {
  await runPaymentDecisionMaintenance(context);
  await runPaymentReconciliationMaintenance(context);
};

/** Deliver durable alert intents at least once. The lease blocks concurrent
 * workers, but a crash after ntfy accepts the request and before the sent write
 * commits can repeat the same non-private error code on a later run. */
export const runPaymentCaseAlertMaintenance = async (
  context: MaintenanceTaskContext,
): Promise<void> => {
  let fullPage = true;
  for (let index = 0; index < PAYMENT_CASE_ALERT_PAGE_SIZE; index += 1) {
    if (!itemFits(context, PAYMENT_CASE_ALERT_ITEM_BUDGET)) {
      context.requestFollowUp();
      return;
    }
    const claim = await claimNextPaymentCaseAlert(PAYMENT_WORK_LEASE_MS);
    if (claim === null) {
      fullPage = false;
      break;
    }
    const delivery = await sendNtfyError("PAYMENT_NEEDS_ACTION");
    if (delivery !== "sent") {
      await releasePaymentCaseAlert(claim);
      throw new Error("Payment needs-action alert delivery failed");
    }
    await markPaymentCaseAlertSent(claim);
  }
  if (fullPage) context.requestFollowUp();
};
