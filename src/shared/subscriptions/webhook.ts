/**
 * Record what one Stripe webhook delivery reports about a subscription.
 *
 * A delivery proves who sent it. It never supplies the facts that the site
 * stores: the site reads the subscription from Stripe, then records what that
 * read answers. A delivery that arrives late or twice lands on the facts that
 * Stripe holds now.
 */

import * as v from "valibot";
import { getLiveRowBySubscriptionIdOrNull } from "#db/subscriptions.ts";
import { ResourceIdSchema } from "#payment/resource-id.ts";
import type { WebhookEvent } from "#shared/payments.ts";
import type { SubscriptionWebhookEvent } from "#shared/stripe/webhook-events.ts";
import { recordStripeReport } from "./record.ts";

/** An invoice of the pinned API version names the subscription that made it
 * under the parent. An invoice that no subscription made names none. */
const InvoiceDeliverySchema = v.object({
  parent: v.nullable(
    v.object({
      subscription_details: v.nullable(
        v.object({ subscription: ResourceIdSchema }),
      ),
    }),
  ),
});

const SubscriptionDeliverySchema = v.object({ id: ResourceIdSchema });

/** The subscription that a delivery of its own object names. */
const subscriptionObjectId = (object: Record<string, unknown>): string =>
  v.parse(SubscriptionDeliverySchema, object).id;

/** The subscription that made an invoice, or null when no subscription made
 * it. */
const invoiceSubscriptionId = (
  object: Record<string, unknown>,
): string | null =>
  v.parse(InvoiceDeliverySchema, object).parent?.subscription_details
    ?.subscription ?? null;

type IdReader = (object: Record<string, unknown>) => string | null;

/** Where each delivery names its subscription. The record is exhaustive over
 * the declared events, so a new event must say where its id lives. */
const SUBSCRIPTION_ID_OF: ReadonlyMap<string, IdReader> = new Map<
  string,
  IdReader
>(
  Object.entries({
    "customer.subscription.created": subscriptionObjectId,
    "customer.subscription.deleted": subscriptionObjectId,
    "customer.subscription.paused": subscriptionObjectId,
    "customer.subscription.resumed": subscriptionObjectId,
    "customer.subscription.updated": subscriptionObjectId,
    "invoice.paid": invoiceSubscriptionId,
    "invoice.payment_action_required": invoiceSubscriptionId,
    "invoice.payment_failed": invoiceSubscriptionId,
  } satisfies Record<SubscriptionWebhookEvent, IdReader>),
);

/** What one delivery asked of the site. `retry` asks Stripe to send the
 * delivery again. */
export type SubscriptionDelivery =
  | { readonly kind: "not_a_subscription" }
  | { readonly kind: "no_live_row" }
  | { readonly kind: "recorded" }
  | { readonly kind: "retry" };

/**
 * Record what one webhook delivery reports. A delivery about a subscription
 * reads it from Stripe and records that answer: the paid renewals reach the
 * ledger, then the status reaches the row.
 *
 * A delivery that names no subscription, or a subscription that this site
 * holds no live row for, owes no work. `retry` means that a Stripe read was
 * refused, so the row still owes work that the next delivery can do.
 */
export const recordSubscriptionDelivery = async (
  delivery: WebhookEvent,
): Promise<SubscriptionDelivery> => {
  const readSubscriptionId = SUBSCRIPTION_ID_OF.get(delivery.type);
  if (readSubscriptionId === undefined) {
    return { kind: "not_a_subscription" };
  }
  const subscriptionId = readSubscriptionId(delivery.data.object);
  if (subscriptionId === null) return { kind: "not_a_subscription" };
  const row = await getLiveRowBySubscriptionIdOrNull(subscriptionId);
  if (row === null) return { kind: "no_live_row" };
  return (await recordStripeReport(row))
    ? { kind: "recorded" }
    : { kind: "retry" };
};
