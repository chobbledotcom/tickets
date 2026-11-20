/** Flat evidence keeps each invoice and attempt distinct in TLA sets. */
import {
  type TlaRecord,
  type TlaRecordSchema,
  tlaModule,
  tlaRecords,
} from "#scripts/verify-models/data.ts";
import { requireValue } from "#shared/required-value.ts";
import { type FactsOf, recordSetsFor } from "./controls.ts";

/* jscpd:ignore-start -- a list of strings, not code */
const RENEWAL_TABLES = {
  arithmetic: [
    "ArithmeticFacts",
    {
      amount: "Int",
      caseId: "Str",
      observedTax: "Int",
      price: "Int",
      tax: "Int",
    },
  ],
  currencies: [
    "CurrencyFacts",
    {
      allMatch: "Bool",
      caseId: "Str",
      status: "Str",
    },
  ],
  expected: ["ExpectedAttempts", { attempt: "Str", scenario: "Str" }],
  expectedInvoices: ["ExpectedInvoices", { attempt: "Str", invoice: "Str" }],
  failedJoins: [
    "FailedJoinFacts",
    {
      amount: "Int",
      attempt: "Int",
      attendee: "Int",
      authorityReturned: "Int",
      booking: "Int",
      confirmed: "Bool",
      consumedReference: "Str",
      held: "Int",
      interval: "Str",
      listing: "Int",
      observedAmount: "Int",
      observedInterval: "Str",
      observedListing: "Int",
      observedReference: "Str",
      observedStatus: "Str",
      observedSubscription: "Str",
      quantity: "Int",
      refundBeforeEnd: "Int",
      refundCash: "Int",
      refunds: "Int",
      status: "Str",
      subscription: "Str",
      tax: "Int",
    },
  ],
  invoices: [
    "InvoiceFacts",
    {
      amount: "Int",
      attempt: "Str",
      attendee: "Str",
      cashReference: "Str",
      expectedAt: "Int",
      expectedGroup: "Str",
      invoice: "Str",
      listing: "Str",
      price: "Int",
      reason: "Str",
      saleReference: "Str",
      tax: "Int",
      vatReference: "Str",
    },
  ],
  journeys: [
    "JourneyFacts",
    {
      attendee: "Int",
      attendeeAccount: "Str",
      booking: "Int",
      cancelReturned: "Bool",
      checkoutAt: "Int",
      expectedAttendee: "Int",
      expectedListing: "Int",
      expectedTrialAt: "Int",
      inputPrice: "Int",
      inputQuantity: "Int",
      interval: "Str",
      listing: "Int",
      listingAccount: "Str",
      observedAmount: "Int",
      observedInterval: "Str",
      observedListing: "Int",
      observedStatus: "Str",
      observedSubscription: "Str",
      phase: "Str",
      price: "Int",
      projectionCount: "Int",
      quantity: "Int",
      rate: "Int",
      requestedAmount: "Int",
      requestedInterval: "Str",
      requestedListing: "Int",
      requestedSubscription: "Str",
      status: "Str",
      subscription: "Str",
      tax: "Int",
      trialAt: "Int",
    },
  ],
  operations: [
    "OperationFacts",
    {
      afterStatus: "Str",
      attempt: "Str",
      beforeStatus: "Str",
      fault: "Bool",
      index: "Int",
      observed: "Str",
      outcome: "Str",
      readStatus: "Str",
      scenario: "Str",
      snapshotAttendee: "Int",
      snapshotId: "Int",
      snapshotListing: "Int",
      snapshotStatus: "Str",
      snapshotSubscription: "Str",
      storedAttendee: "Int",
      storedId: "Int",
      storedListing: "Int",
      storedSubscription: "Str",
    },
  ],
  reads: [
    "ReadFacts",
    {
      kind: "Str",
      ordinal: "Int",
      owner: "Str",
      target: "Str",
    },
  ],
  scenarios: [
    "ScenarioFacts",
    {
      initialStatus: "Str",
      scenario: "Str",
      steps: "Int",
    },
  ],
  snapshots: [
    "SnapshotFacts",
    {
      attempt: "Str",
      cashAmount: "Int",
      cashCount: "Int",
      cashDestination: "Str",
      cashPaidAt: "Int",
      cashReference: "Str",
      cashSource: "Str",
      eventGroup: "Str",
      invoice: "Str",
      otherCount: "Int",
      saleAmount: "Int",
      saleCount: "Int",
      saleDestination: "Str",
      salePaidAt: "Int",
      saleReference: "Str",
      saleSource: "Str",
      scenario: "Str",
      vatAmount: "Int",
      vatCount: "Int",
      vatDestination: "Str",
      vatPaidAt: "Int",
      vatReference: "Str",
      vatSource: "Str",
      when: "Str",
    },
  ],
} as const;
/* jscpd:ignore-end */

export type RenewalFacts = FactsOf<typeof RENEWAL_TABLES>;

const {
  invoices: [, INVOICE_FIELDS],
  snapshots: [, SNAPSHOT_FIELDS],
  ...OTHER_TABLES
} = RENEWAL_TABLES;

type Invoice = RenewalFacts["invoices"][number];

/** Names each ledger field of a snapshot after its time, as in `afterCashAmount`.
 * The fields that only identify the snapshot are left out. */
const legFieldsAt = <Value>(
  when: string,
  {
    attempt,
    invoice,
    scenario,
    when: _when,
    ...legs
  }: Readonly<Record<string, Value>>,
): Record<string, Value> =>
  Object.fromEntries(
    Object.entries(legs).map(([field, value]) => [
      `${when}${field.charAt(0).toUpperCase()}${field.slice(1)}`,
      value,
    ]),
  );

const JOINED_INVOICE_FIELDS: TlaRecordSchema = {
  ...INVOICE_FIELDS,
  ...legFieldsAt("before", SNAPSHOT_FIELDS),
  ...legFieldsAt("after", SNAPSHOT_FIELDS),
};

/** The ledger legs of one invoice at one time. A missing or repeated snapshot
 * is lost evidence, so the join fails. */
const legsAt = (
  facts: RenewalFacts,
  { attempt, invoice }: Invoice,
  when: string,
): TlaRecord => {
  const matches = facts.snapshots.filter(
    (snapshot) =>
      snapshot.attempt === attempt &&
      snapshot.invoice === invoice &&
      snapshot.when === when,
  );
  return legFieldsAt(
    when,
    requireValue(
      matches.length === 1 ? matches[0] : undefined,
      `The invoice ${invoice} of ${attempt} has ${matches.length} ledger snapshots ${when} the call.`,
    ),
  );
};

/** Each invoice fact with its ledger legs before and after the call, so the
 * model reads one row for one invoice. */
const joinedInvoices = (facts: RenewalFacts): TlaRecord[] => {
  if (facts.snapshots.length !== 2 * facts.invoices.length)
    throw new Error("A ledger snapshot has no invoice fact.");
  return facts.invoices.map((invoice) => ({
    ...invoice,
    ...legsAt(facts, invoice, "before"),
    ...legsAt(facts, invoice, "after"),
  }));
};

const recordSets = recordSetsFor(OTHER_TABLES);

export const renderRenewals = (facts: RenewalFacts): string =>
  tlaModule("SubscriptionRenewalsData", [
    ...recordSets(facts),
    tlaRecords("InvoiceFacts", JOINED_INVOICE_FIELDS, joinedInvoices(facts)),
  ]);
