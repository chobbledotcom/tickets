/**
 * Store what Stripe reports about one subscription: each paid renewal reaches
 * the ledger, then the status reaches the booking row.
 *
 * The first payment belongs to the booking, so only renewal invoices post.
 * The invoice id is the identity of each ledger event, so a second record of
 * the same invoice posts nothing.
 */

import { mapRenewal } from "#accounting/mappers.ts";
import { postTransferGroups } from "#accounting/store.ts";
import { type CheckedRow, statusWrite } from "#db/subscriptions.ts";
import type { ProviderRead } from "#payment/provider-read.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
import { ErrorCode, logDebug, logError } from "#shared/logger.ts";
import type { StripePaidInvoice } from "#shared/stripe/schemas.ts";
import { stripeApi } from "#shared/stripe.ts";
import {
  renewalTax,
  type SubscriptionStatus,
} from "#shared/subscriptions/plan.ts";

/** An invoice for a later period, as opposed to the first one the checkout
 * paid, which the booking already holds. */
const isRenewal = (invoice: StripePaidInvoice): boolean =>
  invoice.billing_reason === "subscription_cycle" && invoice.amount_paid > 0;

const renewalLegs = (
  row: CheckedRow,
  invoice: StripePaidInvoice,
): Promise<TransferInput[]> =>
  mapRenewal({
    attendeeId: row.attendee_id,
    invoiceId: invoice.id,
    listingId: row.listing_id,
    occurredAt: new Date(
      invoice.status_transitions.paid_at * 1000,
    ).toISOString(),
    paid: invoice.amount_paid,
    tax: renewalTax(
      { price: row.recurring_price, tax: row.recurring_tax },
      invoice.amount_paid,
    ),
  });

/** Log a Stripe read that came back without an answer. */
export const unread = (row: CheckedRow, read: ProviderRead<unknown>): void => {
  logError({
    code: ErrorCode.STRIPE_SUBSCRIPTION,
    detail: `Subscription ${row.subscription_id} could not be read (${read.status})`,
  });
};

/**
 * Store the status `observed` for the subscription of `row`, with every paid
 * renewal. Stripe reported `observed` before this reads the invoices, so the
 * list holds each payment made up to that status. A row that ends here leaves
 * the check with all its money in the ledger. A refused invoice read leaves
 * the row for the next pass. A refused write throws to the caller.
 */
export const recordObserved = async (
  row: CheckedRow,
  observed: SubscriptionStatus,
): Promise<void> => {
  const invoices = await stripeApi.readPaidInvoices(row.subscription_id);
  if (invoices.status !== "found") return unread(row, invoices);
  await postTransferGroups(
    await Promise.all(
      invoices.resource
        .filter(isRenewal)
        .map((invoice) => renewalLegs(row, invoice)),
    ),
    observed === row.subscription_status ? [] : [statusWrite(row, observed)],
  );
  logDebug("Stripe", `Subscription ${row.subscription_id} is ${observed}`);
};
