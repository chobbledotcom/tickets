import { stub } from "@std/testing/mock";
import { LedgerConflictError } from "#accounting/conflicts.ts";
import { eventGroup, legReference } from "#accounting/refs.ts";
import { selectTransfers } from "#accounting/rows.ts";
import { execute, queryBatch, queryOnePrimary } from "#db/client.ts";
import { notNullGuardFailure } from "#db/query.ts";
import { type CheckedRow, getSubscribedRowOrNull } from "#db/subscriptions.ts";
import { inList } from "#db/where-clauses.ts";
import type { ProviderRead } from "#payment/provider-read.ts";
import type { Transfer } from "#shared/ledger/types.ts";
import { requireValue } from "#shared/required-value.ts";
import type { StripePaidInvoice } from "#shared/stripe/schemas.ts";
import { stripeApi } from "#shared/stripe.ts";
import { recordObserved } from "#shared/subscriptions/record.ts";
import { paidInvoice, seedBooking } from "./environment.ts";
import type {
  IdentityChange,
  RenewalCase,
  RenewalPass,
} from "./renewal-cases.ts";
import type { RenewalFacts } from "./renewal-facts.ts";

const WRITE_FAULT = "model renewal write refused";

/** Keep every provider-read argument, even if a later call uses the right id. */
export const captureRead = <Answer>(
  reads: RenewalFacts["reads"],
  kind: "renewal" | "currency",
  owner: string,
  answer: () => Promise<Answer>,
): ((target: string) => Promise<Answer>) => {
  let ordinal = 0;
  return (target) => {
    reads.push({ kind, ordinal: ordinal++, owner, target });
    return answer();
  };
};

/** This row can disappear when a merge replaces its booking identity. */
type CurrentRow = {
  attendee_id: number;
  id: number;
  listing_id: number;
  subscription_id: string;
  subscription_status: string;
};

const currentRowOrNull = (id: number): Promise<CurrentRow | null> =>
  queryOnePrimary(
    `SELECT booking.id, booking.attendee_id, booking.listing_id,
            booking.subscription_id, booking.subscription_status
       FROM listing_attendees AS booking WHERE booking.id = ?`,
    [id],
  );

/** Blank role values mean no leg of that kind. Counts retain duplicates. */
const roleSummary = (legs: readonly Transfer[], kind: string) => {
  const matches = legs.filter((leg) => leg.kind === kind);
  const first = matches[0];
  return {
    amount: matches.reduce((amount, leg) => amount + leg.amount, 0),
    count: matches.length,
    destination: first
      ? `${first.destination.type}:${first.destination.id}`
      : "",
    paidAt: first ? Date.parse(first.occurredAt) / 1000 : 0,
    reference: first?.reference ?? "",
    source: first ? `${first.source.type}:${first.source.id}` : "",
  };
};

const snapshotOf = (
  scenario: string,
  attempt: string,
  when: string,
  invoice: RenewalFacts["invoices"][number],
  allLegs: readonly Transfer[],
): RenewalFacts["snapshots"][number] => {
  const legs = allLegs.filter(
    (leg) => leg.eventGroup === invoice.expectedGroup,
  );
  const cash = roleSummary(legs, "payment");
  const sale = roleSummary(legs, "sale");
  const vat = roleSummary(legs, "vat");
  return {
    attempt,
    cashAmount: cash.amount,
    cashCount: cash.count,
    cashDestination: cash.destination,
    cashPaidAt: cash.paidAt,
    cashReference: cash.reference,
    cashSource: cash.source,
    eventGroup: legs[0]?.eventGroup ?? "",
    invoice: invoice.invoice,
    otherCount: legs.length - cash.count - sale.count - vat.count,
    saleAmount: sale.amount,
    saleCount: sale.count,
    saleDestination: sale.destination,
    salePaidAt: sale.paidAt,
    saleReference: sale.reference,
    saleSource: sale.source,
    scenario,
    vatAmount: vat.amount,
    vatCount: vat.count,
    vatDestination: vat.destination,
    vatPaidAt: vat.paidAt,
    vatReference: vat.reference,
    vatSource: vat.source,
    when,
  };
};

const invoiceEvidence = async (
  scenario: RenewalCase,
  attempt: string,
  row: CheckedRow,
  invoices: readonly StripePaidInvoice[],
): Promise<RenewalFacts["invoices"]> =>
  Promise.all(
    invoices.map(async (invoice) => ({
      amount: invoice.amount_paid,
      attempt,
      attendee: `attendee:${row.attendee_id}`,
      cashReference: await legReference(["renewal", invoice.id, "payment"]),
      expectedAt: invoice.status_transitions.paid_at,
      expectedGroup: await eventGroup(["renewal", invoice.id]),
      invoice: invoice.id,
      listing: `revenue:${row.listing_id}`,
      price: scenario.price,
      reason: invoice.billing_reason ?? "",
      saleReference: await legReference(["renewal", invoice.id, "sale"]),
      tax: scenario.tax,
      vatReference: await legReference(["renewal", invoice.id, "vat"]),
    })),
  );

const readAnswer = (
  status: RenewalPass["read"],
  invoices: readonly StripePaidInvoice[],
): ProviderRead<readonly StripePaidInvoice[]> => {
  switch (status) {
    case "found":
      return { resource: invoices, status };
    case "missing":
      return { status };
    case "invalid":
      return { reason: "mismatched_money", status };
    case "unavailable":
      return { reason: "timeout", status };
  }
};

const numberChange = (
  column: "attendee_id" | "id" | "listing_id",
  current: number,
  increment: number,
) => ({ column, value: current + increment });

const changeIdentity = async (
  change: IdentityChange,
  row: CheckedRow,
): Promise<void> => {
  const changes = {
    attendee: numberChange("attendee_id", row.attendee_id, 1),
    id: numberChange("id", row.id, 5000),
    listing: numberChange("listing_id", row.listing_id, 1),
    status: { column: "subscription_status", value: "canceled" },
    subscription: {
      column: "subscription_id",
      value: `${row.subscription_id}_replacement`,
    },
  } as const;
  const { column, value } = changes[change];
  await execute(`UPDATE listing_attendees SET ${column} = ? WHERE id = ?`, [
    value,
    row.id,
  ]);
};

const recordOutcome = async (write: () => Promise<void>): Promise<string> => {
  try {
    await write();
    return "returned";
  } catch (error) {
    if (error instanceof LedgerConflictError) return "ledger_conflict";
    if (notNullGuardFailure(error, "listing_attendees.listing_id"))
      return "booking_fence";
    if (error instanceof Error && error.message.includes(WRITE_FAULT))
      return "write_fault";
    throw error;
  }
};

const setWriteFault = (): Promise<unknown> =>
  execute(
    `CREATE TRIGGER model_renewal_fault BEFORE INSERT ON transfers
   WHEN NEW.kind = 'sale'
   BEGIN SELECT RAISE(ABORT, '${WRITE_FAULT}'); END`,
  );

/** The snapshots surround the actual recordObserved call and its one atomic batch. */
export const observePass = async (
  facts: RenewalFacts,
  scenario: RenewalCase,
  row: CheckedRow,
  pass: RenewalPass,
  index: number,
  write: () => Promise<void> = () => recordObserved(row, pass.observed),
): Promise<void> => {
  const attempt = `${scenario.name}:${index}`;
  const expectedInvoices = pass.invoices.map((invoice) => ({
    attempt,
    invoice: `in_${scenario.name}_${invoice.id}`,
  }));
  facts.expectedInvoices.push(...expectedInvoices);
  const invoices = pass.invoices.map((input) => {
    const supplied = paidInvoice(
      `in_${scenario.name}_${input.id}`,
      input.amount,
    );
    return {
      ...supplied,
      billing_reason: input.reason,
      status_transitions: {
        paid_at: input.paidAt ?? supplied.status_transitions.paid_at,
      },
    };
  });
  const inputs = await invoiceEvidence(scenario, attempt, row, invoices);
  const readLegs = () =>
    selectTransfers(queryBatch, {
      where: inList(
        "event_group",
        inputs.map((invoice) => invoice.expectedGroup),
      ),
    });
  const before = await currentRowOrNull(row.id);
  const beforeLegs = await readLegs();
  if (pass.fault) await setWriteFault();
  let outcome: string;
  using _invoices = stub(
    stripeApi,
    "readPaidInvoices",
    captureRead(facts.reads, "renewal", attempt, () =>
      Promise.resolve(readAnswer(pass.read, invoices)),
    ),
  );
  const previousExpectedError = Deno.env.get("TEST_EXPECT_ERROR");
  if (pass.read !== "found") Deno.env.set("TEST_EXPECT_ERROR", "1");
  try {
    outcome = await recordOutcome(write);
  } finally {
    if (pass.fault) await execute("DROP TRIGGER model_renewal_fault");
    if (previousExpectedError === undefined)
      Deno.env.delete("TEST_EXPECT_ERROR");
    else Deno.env.set("TEST_EXPECT_ERROR", previousExpectedError);
  }
  const after = await currentRowOrNull(row.id);
  const afterLegs = await readLegs();
  const operation: RenewalFacts["operations"][number] = {
    afterStatus: after?.subscription_status ?? "",
    attempt,
    beforeStatus: before?.subscription_status ?? "",
    fault: pass.fault,
    index,
    observed: pass.observed,
    outcome,
    readStatus: pass.read,
    scenario: scenario.name,
    snapshotAttendee: row.attendee_id,
    snapshotId: row.id,
    snapshotListing: row.listing_id,
    snapshotStatus: row.subscription_status,
    snapshotSubscription: row.subscription_id,
    storedAttendee: before?.attendee_id ?? 0,
    storedId: before?.id ?? 0,
    storedListing: before?.listing_id ?? 0,
    storedSubscription: before?.subscription_id ?? "",
  };
  facts.operations.push(operation);
  facts.invoices.push(...inputs);
  for (const invoice of inputs) {
    facts.snapshots.push(
      snapshotOf(scenario.name, attempt, "before", invoice, beforeLegs),
      snapshotOf(scenario.name, attempt, "after", invoice, afterLegs),
    );
  }
};

export const observeCase = async (
  facts: RenewalFacts,
  scenario: RenewalCase,
  position: number,
): Promise<void> => {
  const id = position * 2 + 1;
  await seedBooking({
    attendeeId: id,
    id,
    listingId: id,
    plan: {
      amount: scenario.price,
      id: `sub_${scenario.name}`,
      interval: "month",
      status: "trialing",
      tax: scenario.tax,
    },
    quantity: 1,
  });
  await seedBooking({
    attendeeId: id + 1,
    id: id + 10000,
    listingId: id + 1,
    quantity: 1,
  });
  const first = requireValue(
    await getSubscribedRowOrNull(id),
    "Seeded subscription is absent",
  );
  if (scenario.change) await changeIdentity(scenario.change, first);
  const initial = await currentRowOrNull(id);
  facts.scenarios.push({
    initialStatus: initial?.subscription_status ?? "",
    scenario: scenario.name,
    steps: scenario.passes.length,
  });
  for (const [index, pass] of scenario.passes.entries()) {
    const row = scenario.change
      ? first
      : requireValue(
          await getSubscribedRowOrNull(id),
          "Subscription disappeared before retry",
        );
    await observePass(facts, scenario, row, pass, index);
  }
};
