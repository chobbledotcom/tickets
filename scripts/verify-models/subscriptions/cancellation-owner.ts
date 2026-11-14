/** Execute owner cancellation and the guarded SQL against real stored plans. */
import { execute, queryAll } from "#db/client.ts";
import { getSubscribedRowOrNull, statusWrite } from "#db/subscriptions.ts";
import type {
  CancellationFacts,
  CancellationFault,
} from "#scripts/verify-models/subscriptions/cancellation-facts.ts";
import {
  invokeOwnerCancellation,
  type OwnerAttemptResult,
  type OwnerCase,
  type OwnerProbe,
  type OwnerSnapshot,
  prepareOwnerSnapshot,
  withOwnerProvider,
} from "#scripts/verify-models/subscriptions/cancellation-owner-fixture.ts";
import {
  cancellationInvoiceEvidence,
  cancellationLedgerSummary,
  cancellationProbeFacts,
  cancellationRefusalCases,
} from "#scripts/verify-models/subscriptions/cancellation-support.ts";
import {
  seedBooking,
  withSubscriptionDb,
} from "#scripts/verify-models/subscriptions/environment.ts";
import { requireValue } from "#shared/required-value.ts";
import {
  SUBSCRIPTION_NODE_OF,
  type SubscriptionStatus,
  SubscriptionStatusSchema,
} from "#shared/subscriptions/plan.ts";

const statuses = SubscriptionStatusSchema.options;
const lives = statuses.filter(
  (status) => SUBSCRIPTION_NODE_OF[status] === "live",
);

const ownerCase = (
  sample: OwnerCase,
  fault: CancellationFault,
): Promise<CancellationFacts["owners"][number]> =>
  withSubscriptionDb(async () => {
    const snapshot = await prepareOwnerSnapshot(sample);
    return withOwnerProvider(sample, fault, async (probe) => {
      const result = await invokeOwnerCancellation(snapshot.row, sample, fault);
      return ownerReadback(sample, snapshot, probe, result);
    });
  });

const ownerReadback = async (
  sample: OwnerCase,
  snapshot: OwnerSnapshot,
  probe: OwnerProbe,
  result: OwnerAttemptResult,
): Promise<CancellationFacts["owners"][number]> => {
  const { row, before, storedId } = snapshot;
  const { observed, invoicesRead } = probe;
  const { returned, threw } = result;
  const after = requireValue(
    await getSubscribedRowOrNull(storedId),
    "Owner after row missing",
  );
  const legs = await queryAll<{
    amount: number;
    kind: string;
    event_group: string;
  }>("SELECT amount, kind, event_group FROM transfers");
  const first = await cancellationInvoiceEvidence(legs, "in_final_a");
  const second = await cancellationInvoiceEvidence(legs, "in_final_b");
  const payment = cancellationLedgerSummary(legs, "payment");
  return {
    ...cancellationProbeFacts(probe),
    after: after.subscription_status,
    attempt: 1,
    attendeeId: after.attendee_id,
    before: before.subscription_status,
    bookingId: after.id,
    cash: payment.cash,
    firstCash: first.cash,
    firstGroup: first.group,
    firstInvoice: first.invoice,
    firstLegs: first.legs,
    identityCurrent: sample.change === undefined || sample.change === "status",
    invoicesRead,
    legs: legs.length,
    listingId: after.listing_id,
    observed,
    planKept:
      after.recurring_price === before.recurring_price &&
      after.recurring_tax === before.recurring_tax &&
      after.subscription_id === before.subscription_id &&
      after.recurring_interval === before.recurring_interval,
    quantity: after.quantity,
    returned,
    scenario: sample.scenario,
    secondCash: second.cash,
    secondGroup: second.group,
    secondInvoice: second.invoice,
    secondLegs: second.legs,
    subscriptionId: row.subscription_id,
    threw,
  };
};

export const ownerFacts = async (
  fault: CancellationFault,
): Promise<CancellationFacts["owners"]> => {
  const cases: OwnerCase[] = [
    { scenario: "owner-final" },
    { cancelRefused: true, scenario: "owner-read-ended" },
    ...cancellationRefusalCases("owner-both", {
      cancelRefused: true,
      readRefused: true,
    }),
    ...cancellationRefusalCases("owner-invoice", { invoiceRefused: true }),
    { ledgerFault: true, scenario: "owner-ledger-fault" },
    { change: "status", scenario: "owner-stale-status", status: "trialing" },
    ...(["attendee", "listing", "subscription", "id"] as const).map(
      (change) => ({ change, scenario: `owner-replaced-${change}` }),
    ),
    ...statuses.map((status) => ({
      scenario: `owner-observed-${status}`,
      status,
    })),
  ];
  const facts: CancellationFacts["owners"] = [];
  for (const sample of cases) facts.push(await ownerCase(sample, fault));
  return facts;
};

type GuardInput = {
  id: number;
  snapshot: SubscriptionStatus;
  before: SubscriptionStatus;
  target: SubscriptionStatus;
  fault: CancellationFault;
};

/** A zero-row UPDATE is an observed refusal, not an exception. */
const guardedWrite = async ({
  id,
  snapshot,
  before,
  target,
  fault,
}: GuardInput): Promise<CancellationFacts["writes"][number]> => {
  await seedBooking({
    attendeeId: 1,
    id,
    listingId: 1,
    plan: {
      amount: 600,
      id: `sub_guard_${id}`,
      interval: "month",
      status: before,
      tax: 0,
    },
    quantity: 0,
  });
  const row = requireValue(
    await getSubscribedRowOrNull(id),
    "Guard row missing",
  );
  const statement = statusWrite(
    { ...row, subscription_status: snapshot },
    target,
  );
  const result = await execute(statement.sql, statement.args);
  if (
    fault === "stale-overwrite" &&
    snapshot === "active" &&
    before === "canceled" &&
    target === "active"
  )
    await execute(
      "UPDATE listing_attendees SET subscription_status = ? WHERE id = ?",
      [target, id],
    );
  const stored = requireValue(
    await getSubscribedRowOrNull(id),
    "Guard readback missing",
  );
  return {
    affected: result.rowsAffected,
    after: stored.subscription_status,
    attempt: 1,
    before,
    scenario: `guard-${id}`,
    snapshot,
    target,
  };
};

/** Every live snapshot, concurrent stored status, and requested status runs SQL. */
export const guardedWriteFacts = (
  fault: CancellationFault,
): Promise<CancellationFacts["writes"]> =>
  withSubscriptionDb(async () => {
    const facts: CancellationFacts["writes"] = [];
    let id = 0;
    for (const snapshot of lives)
      for (const before of statuses)
        for (const target of statuses) {
          id++;
          facts.push(
            await guardedWrite({ before, fault, id, snapshot, target }),
          );
        }
    return facts;
  });
