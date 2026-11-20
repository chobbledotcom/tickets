/** Owner snapshots, exact refusal handling, and local provider boundaries. */
import { execute } from "#db/client.ts";
import { sql, sqlLiteral } from "#db/sql.ts";
import {
  getSubscribedRowOrNull,
  type LiveRow,
  type SubscribedRow,
} from "#db/subscriptions.ts";
import type { ProviderRead } from "#payment/provider-read.ts";
import type { CancellationFault } from "#scripts/verify-models/subscriptions/cancellation-facts.ts";
import {
  type CancellationProbe,
  type CancellationProvider,
  cancellationProbe,
  observeCancellationRead,
  restoreCancellationProvider,
  withRestoredProvider,
} from "#scripts/verify-models/subscriptions/cancellation-support.ts";
import {
  paidInvoice,
  providerSubscription,
  seedBooking,
} from "#scripts/verify-models/subscriptions/environment.ts";
import { requireValue } from "#shared/required-value.ts";
import type { StripeSubscription } from "#shared/stripe/schemas.ts";
import { stripeApi } from "#shared/stripe.ts";
import {
  cancelOwnerSubscription,
  type OwnerCancel,
} from "#shared/subscriptions/cancellation.ts";
import type { SubscriptionStatus } from "#shared/subscriptions/plan.ts";
import { outcomeOf } from "./environment.ts";

export const OWNER_START = {
  amount: 600,
  id: "sub_owner",
  interval: "month",
  listingId: 1,
  status: "active",
} as const;
const LEDGER_FAULT = "model_cancel_ledger_fault";
const IDENTITY_REFUSAL =
  "NOT NULL constraint failed: listing_attendees.listing_id";

export type OwnerCase = {
  scenario: string;
  status?: SubscriptionStatus;
  cancelRefused?: boolean;
  readRefused?: boolean;
  invoiceRefused?: boolean;
  noRenewals?: boolean;
  refusal?: ProviderRead<never>;
  ledgerFault?: boolean;
  change?: "status" | "attendee" | "listing" | "subscription" | "id";
};

/** Replace one fence field while the provider read holds the original snapshot. */
const replaceOwnerSnapshot = async (
  change: OwnerCase["change"],
): Promise<number> => {
  switch (change) {
    case "status":
      await execute(
        sql`UPDATE listing_attendees SET subscription_status = 'canceled' WHERE id = 1`,
      );
      break;
    case "attendee":
      await execute(
        sql`INSERT INTO attendees (id, created) VALUES (2, '2026-03-01T00:00:00.000Z')`,
      );
      await execute(
        sql`UPDATE listing_attendees SET attendee_id = 2 WHERE id = 1`,
      );
      break;
    case "listing":
      await seedBooking({ attendeeId: 2, id: 2, listingId: 2, quantity: 0 });
      await execute(sql`DELETE FROM listing_attendees WHERE id = 2`);
      await execute(
        sql`UPDATE listing_attendees SET listing_id = 2 WHERE id = 1`,
      );
      break;
    case "subscription":
      await execute(
        sql`UPDATE listing_attendees SET subscription_id = 'sub_replaced' WHERE id = 1`,
      );
      break;
    case "id":
      await execute(sql`UPDATE listing_attendees SET id = 2 WHERE id = 1`);
      return 2;
  }
  return 1;
};

export type OwnerSnapshot = {
  row: SubscribedRow;
  before: SubscribedRow;
  storedId: number;
};

export const prepareOwnerSnapshot = async (
  sample: OwnerCase,
): Promise<OwnerSnapshot> => {
  await seedBooking({
    attendeeId: 1,
    id: 1,
    listingId: 1,
    plan: { ...OWNER_START, tax: 0 },
    quantity: 1,
  });
  const row = requireValue(
    await getSubscribedRowOrNull(1),
    "Owner fixture row missing",
  );
  const storedId = await replaceOwnerSnapshot(sample.change);
  if (sample.ledgerFault)
    await execute(sql`CREATE TRIGGER model_cancel_fault BEFORE INSERT ON transfers
    WHEN NEW.kind = 'sale' BEGIN SELECT RAISE(ABORT, ${sqlLiteral(LEDGER_FAULT)}); END`);
  const before = requireValue(
    await getSubscribedRowOrNull(storedId),
    "Owner before row missing",
  );
  return { before, row, storedId };
};

export type OwnerProbe = CancellationProbe & {
  observed: string;
  invoicesRead: boolean;
  finalInvoices: number;
};

/** Restore every replaced boundary even when the real SQL write refuses. */
export const withOwnerProvider: CancellationProvider<
  OwnerCase,
  OwnerProbe
> = async (sample, fault, run) => {
  const refusal =
    sample.refusal ??
    ({ reason: "rejected_request", status: "invalid" } as const);
  const probe: OwnerProbe = {
    ...cancellationProbe(),
    finalInvoices: 0,
    invoicesRead: false,
    observed: "unread",
  };
  const restoreProvider = restoreCancellationProvider();
  const answer = (id: string): ProviderRead<StripeSubscription> => {
    probe.observed = sample.status ?? "canceled";
    return {
      resource: providerSubscription({
        ...OWNER_START,
        id,
        status: sample.status ?? "canceled",
      }),
      status: "found",
    };
  };
  const subscriptionReply = (refused: boolean | undefined, id: string) =>
    Promise.resolve(refused ? refusal : answer(id));
  stripeApi.cancelSubscription = (id) => {
    probe.cancels++;
    probe.requestId = id;
    return subscriptionReply(sample.cancelRefused, id);
  };
  const readSubscription: typeof stripeApi.readSubscription = (id) => {
    observeCancellationRead(probe, "subscription", id, OWNER_START.id);
    return subscriptionReply(sample.readRefused, id);
  };
  const readPaidInvoices: typeof stripeApi.readPaidInvoices = (id) => {
    observeCancellationRead(probe, "invoice", id, OWNER_START.id);
    probe.invoicesRead = !sample.invoiceRefused;
    const invoices = sample.noRenewals
      ? []
      : [paidInvoice("in_final_a"), paidInvoice("in_final_b")];
    if (!sample.invoiceRefused) probe.finalInvoices = invoices.length;
    return Promise.resolve(
      sample.invoiceRefused
        ? refusal
        : { resource: invoices, status: "found" as const },
    );
  };
  // Faults change the forwarded request before the observing provider boundary.
  stripeApi.readSubscription = (id) =>
    readSubscription(
      fault === "wrong-owner-subscription-read" &&
        sample.scenario === "owner-read-ended"
        ? "sub_wrong"
        : id,
    );
  stripeApi.readPaidInvoices = (id) =>
    readPaidInvoices(
      fault === "wrong-owner-invoice-read" && sample.scenario === "owner-final"
        ? "sub_wrong"
        : id,
    );
  return withRestoredProvider(restoreProvider, probe, run);
};

const expectedOwnerFailure = (
  error: unknown,
  sample: OwnerCase,
  fault: CancellationFault,
): boolean => {
  const message = String(error);
  if (sample.ledgerFault) return message.includes(LEDGER_FAULT);
  const replaced = sample.change !== undefined && sample.change !== "status";
  const wrongCommand =
    fault === "wrong-cancellation-identity" &&
    sample.scenario === "owner-final";
  return (replaced || wrongCommand) && message.includes(IDENTITY_REFUSAL);
};

/** A control changes the stored row of one case. */
type Tamper = (sample: OwnerCase, fault: CancellationFault) => Promise<void>;

const tamperOwnerStatus: Tamper = async (sample, fault) => {
  if (fault === "local-end-without-money" && sample.ledgerFault)
    await execute(
      sql`UPDATE listing_attendees SET subscription_status = 'canceled' WHERE id = 1`,
    );
};

/** The control makes the stored row disagree with a cancelled answer. */
const tamperCancelledRow: Tamper = async (sample, fault) => {
  if (
    fault === "cancelled-answer-on-live-row" &&
    sample.scenario === "owner-final"
  )
    await execute(
      sql`UPDATE listing_attendees SET subscription_status = 'active' WHERE id = 1`,
    );
};

export type OwnerAttemptResult = {
  answer: OwnerCancel | "threw";
  threw: boolean;
};

/** The wrong-identity control changes the input before the actual provider call. */
export const invokeOwnerCancellation = async (
  row: LiveRow,
  sample: OwnerCase,
  fault: CancellationFault,
): Promise<OwnerAttemptResult> => {
  if (
    fault === "zero-renewal-identity-bypass" &&
    sample.scenario === "owner-no-renewals-replaced-subscription"
  )
    await execute(sql`CREATE TRIGGER model_cancel_skip_identity
      BEFORE INSERT ON listing_attendees WHEN NEW.listing_id IS NULL
      BEGIN SELECT RAISE(IGNORE); END`);
  const wrongCommand =
    fault === "wrong-cancellation-identity" &&
    sample.scenario === "owner-final";
  const command = wrongCommand ? { ...row, subscriptionId: "sub_wrong" } : row;
  const result = await outcomeOf<OwnerAttemptResult>(
    async () => ({
      answer: await cancelOwnerSubscription(command),
      threw: false,
    }),
    [
      [
        (error) => expectedOwnerFailure(error, sample, fault),
        { answer: "threw", threw: true },
      ],
    ],
  );
  if (result.threw) await tamperOwnerStatus(sample, fault);
  else await tamperCancelledRow(sample, fault);
  return result;
};
