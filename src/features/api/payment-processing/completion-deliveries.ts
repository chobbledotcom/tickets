import { logActivity } from "#shared/db/activityLog.ts";
import {
  completePaymentCompletionDelivery,
  getPaymentCompletionDeliveriesByKeys,
  getPendingPaymentCompletionDeliveries,
  savePaymentCompletionDeliveryData,
} from "#shared/db/payments/completion-deliveries.ts";
import { settings } from "#shared/db/settings.ts";
import {
  type EmailEntry,
  prepareRegistrationEmailDeliveries,
  sendPreparedRegistrationEmail,
} from "#shared/email.ts";
import type {
  PaymentCompletionDeliveryData,
  PreparedPaymentCompletionDelivery,
  SiteAssignmentDelivery,
} from "#shared/payment-completion-delivery.ts";
import { applyPaidRenewal, paidRenewalDeliveriesFor } from "#shared/renewal.ts";
import {
  applyPaidSiteAssignment,
  paidSiteAssignment,
  preparePaidSiteAssignmentDeliveries,
  sendPreparedSiteAssignmentEmail,
} from "#shared/site-assignment-paid.ts";
import {
  prepareRegistrationWebhookDeliveries,
  sendPreparedRegistrationWebhook,
} from "#shared/webhook-paid.ts";
import type { CompletionCurrent } from "./completion-runtime.ts";

export const preparePaidCompletionDeliveries = async (
  current: CompletionCurrent,
  entries: EmailEntry[],
  siteTokenIndex: string | undefined,
): Promise<PreparedPaymentCompletionDelivery[]> => {
  const currency = settings.currency;
  const [emails, webhooks, sites, renewals] = await Promise.all([
    prepareRegistrationEmailDeliveries(entries, currency),
    prepareRegistrationWebhookDeliveries(entries, currency),
    preparePaidSiteAssignmentDeliveries(current.payment.id, entries),
    paidRenewalDeliveriesFor(siteTokenIndex)(entries),
  ]);
  return [...emails, ...webhooks, ...sites, ...renewals];
};

const siteAssignmentsForEmail = async (
  paymentId: string,
  keys: readonly string[],
) => {
  const rows = await getPaymentCompletionDeliveriesByKeys(paymentId, keys);
  if (rows.length !== keys.length) {
    throw new Error(`Payment ${paymentId} has missing site assignments`);
  }
  return rows.map(({ data }) => {
    if (data.kind !== "site_assignment" || data.site === null) {
      throw new Error(`Payment ${paymentId} has unfinished site assignments`);
    }
    return paidSiteAssignment(data);
  });
};

const deliverSiteAssignment = (
  current: CompletionCurrent,
  deliveryId: number,
  data: SiteAssignmentDelivery,
): Promise<void> =>
  applyPaidSiteAssignment(data, (staged) =>
    savePaymentCompletionDeliveryData(current.claim, deliveryId, staged),
  );

const deliverPaymentCompletionData = async (
  current: CompletionCurrent,
  deliveryId: number,
  data: PaymentCompletionDeliveryData,
): Promise<void> => {
  switch (data.kind) {
    case "registration_email":
      await sendPreparedRegistrationEmail(data);
      break;
    case "registration_webhook":
      await sendPreparedRegistrationWebhook(data);
      break;
    case "site_assignment":
      await deliverSiteAssignment(current, deliveryId, data);
      break;
    case "site_assignment_email":
      await sendPreparedSiteAssignmentEmail(
        data,
        await siteAssignmentsForEmail(current.payment.id, data.assignmentKeys),
      );
      break;
    case "renewal": {
      const activity = await applyPaidRenewal(data);
      await completePaymentCompletionDelivery(
        current.claim,
        deliveryId,
        async (transaction) => {
          await logActivity(
            activity.message,
            activity.listingId,
            undefined,
            transaction,
          );
        },
      );
      return;
    }
  }
  await completePaymentCompletionDelivery(current.claim, deliveryId);
};

/** Deliver at most one row. A look-ahead row makes `false` mean that another
 * maintenance invocation is needed; no destination is dropped. */
export const deliverNextPaidCompletion = async (
  current: CompletionCurrent,
): Promise<boolean> => {
  const pending = await getPendingPaymentCompletionDeliveries(
    current.payment.id,
  );
  const next = pending[0];
  if (next === undefined) return true;
  await deliverPaymentCompletionData(current, next.id, next.data);
  return pending.length === 1;
};
