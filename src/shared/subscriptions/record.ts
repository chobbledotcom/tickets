/**
 * Record what Stripe reports about one subscription: each paid renewal reaches
 * the ledger, then the status reaches the booking row.
 *
 * The first payment belongs to the booking. Every later paid invoice posts: a
 * cycle, a proration from a dashboard change, or a manual charge. The
 * invoice id is the identity of each ledger event, so a second
 * record of the same invoice posts nothing. The scheduled check and a webhook
 * delivery both record through here.
 */

import { mapRenewal } from "#accounting/mappers.ts";
import { postTransferGroups } from "#accounting/store.ts";
import { settings } from "#db/settings.ts";
import {
  type LiveRow,
  renewalBookingGuard,
  statusWrite,
} from "#db/subscriptions.ts";
import { partition } from "#fp";
import type { ProviderRead, ProviderReader } from "#payment/provider-read.ts";
import { observedStatusNode } from "#payment/subscription-machine-spec.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
import { ErrorCode, logDebug, logError } from "#shared/logger.ts";
import type { StripePaidInvoice } from "#shared/stripe/schemas.ts";
import { stripeApi } from "#shared/stripe.ts";
import {
  renewalTax,
  type SubscriptionStatus,
} from "#shared/subscriptions/plan.ts";

/** A paid invoice after the first one. The checkout paid the first one, and
 * the booking already holds that payment. */
const isRenewal = (invoice: StripePaidInvoice): boolean =>
  invoice.billing_reason !== "subscription_create" && invoice.amount_paid > 0;

/** The site prices every subscription in its own currency. A renewal in
 * another currency cannot post against those prices, so the owner records it
 * by hand. */
const isInSiteCurrency = (invoice: StripePaidInvoice): boolean =>
  invoice.currency === settings.currency.toLowerCase();

const logForeignRenewal = (row: LiveRow, invoice: StripePaidInvoice): void =>
  logError({
    code: ErrorCode.STRIPE_SUBSCRIPTION,
    detail: `Subscription ${row.subscriptionId} invoice ${invoice.id} is in ${invoice.currency}, not the site currency. The ledger does not hold it.`,
  });

/** The renewals that can post. Each one in another currency is logged and
 * left out. */
const postableRenewals = (
  row: LiveRow,
  invoices: readonly StripePaidInvoice[],
): StripePaidInvoice[] => {
  const [postable, foreign] = partition(isInSiteCurrency)(
    invoices.filter(isRenewal),
  );
  for (const invoice of foreign) logForeignRenewal(row, invoice);
  return postable;
};

const renewalLegs = (
  row: LiveRow,
  invoice: StripePaidInvoice,
): Promise<TransferInput[]> =>
  mapRenewal({
    attendeeId: row.attendeeId,
    invoiceId: invoice.id,
    listingId: row.listingId,
    occurredAt: new Date(
      invoice.status_transitions.paid_at * 1000,
    ).toISOString(),
    paid: invoice.amount_paid,
    tax: renewalTax(
      { price: row.recurringPrice, tax: row.recurringTax },
      invoice.amount_paid,
    ),
  });

/** What one record of a Stripe report did. `unavailable` means that Stripe
 * did not answer, so a later read can succeed. `refused` means that Stripe
 * answered with no usable subscription, so the same read will fail again. */
export type ReportOutcome = "recorded" | "refused" | "unavailable";

type ReadRefusal = Exclude<ProviderRead<never>, { status: "found" }>;

const outcomeOf = (answer: ReadRefusal): ReportOutcome =>
  answer.status === "unavailable" ? "unavailable" : "refused";

const causeOf = (answer: ReadRefusal): string =>
  answer.status === "missing"
    ? answer.status
    : `${answer.status}: ${answer.reason}`;

/** Read one resource of the subscription of `row`. A refused read is logged
 * with its cause. */
export const readForSubscription = async <Resource>(
  row: LiveRow,
  read: ProviderReader<Resource>,
): Promise<ProviderRead<Resource>> => {
  const answer = await read(row.subscriptionId);
  if (answer.status !== "found") {
    logError({
      code: ErrorCode.STRIPE_SUBSCRIPTION,
      detail: `Subscription ${row.subscriptionId} could not be read (${causeOf(answer)})`,
    });
  }
  return answer;
};

/**
 * Store the status `observed` for the subscription of `row`, with every paid
 * renewal. Stripe reported `observed` before this reads the invoices, so the
 * list holds each payment made up to that status. A row that ends here keeps
 * all its money in the ledger. Every write requires the same booking identity,
 * even without renewals. A refused invoice read writes nothing. A refused
 * write throws to the caller.
 */
export const recordObserved = async (
  row: LiveRow,
  observed: SubscriptionStatus,
): Promise<ReportOutcome> => {
  const invoices = await readForSubscription(row, stripeApi.readPaidInvoices);
  if (invoices.status !== "found") return outcomeOf(invoices);
  const groups = await Promise.all(
    postableRenewals(row, invoices.resource).map((invoice) =>
      renewalLegs(row, invoice),
    ),
  );
  const companion =
    groups.length > 0 || observed !== row.subscriptionStatus
      ? [renewalBookingGuard(row)]
      : [];
  if (observed !== row.subscriptionStatus)
    companion.push(statusWrite(row, observed));
  await postTransferGroups(groups, companion);
  logDebug("Stripe", `Subscription ${row.subscriptionId} is ${observed}`);
  return "recorded";
};

/** Read what Stripe reports for one live row, then record it. */
export const recordStripeReport = async (
  row: LiveRow,
): Promise<ReportOutcome> => {
  const subscription = await readForSubscription(
    row,
    stripeApi.readSubscription,
  );
  if (subscription.status !== "found") return outcomeOf(subscription);
  const observed = subscription.resource.status;
  observedStatusNode(row.subscriptionStatus, observed);
  return recordObserved(row, observed);
};
