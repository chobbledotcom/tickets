/* Fixture triples for the refund reversal proof: one attendee's legs,
 * assessments and returned references, with a short label per account refund
 * group. The production predicates that read a group are rebuilt here from
 * the fixture legs on every run, never stored. */

/* jscpd:ignore-start -- imports */
import {
  attendeeAccount,
  revenueAccount,
  TAX_VAT,
  WORLD,
  WRITEOFF,
} from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import { bookingEventGroup } from "#accounting/mappers.ts";
import { once } from "#fp";
import type { TransferInput } from "#shared/ledger/types.ts";
import { isRefundLeg } from "#shared/refund-ledger/plan.ts";
import type { RefundReferences } from "#shared/refund-ledger/result.ts";
import { requireValue } from "#shared/required-value.ts";
import { assessTax } from "#shared/tax/assessment.ts";
import type { StoredTaxAssessment } from "#shared/tax/store.ts";
import { NO_TAX } from "#shared/tax/types.ts";

/* jscpd:ignore-end */

const BOOKING_AT = "2026-06-21T00:00:00.000Z";

export type Fixture = {
  readonly assessments: readonly StoredTaxAssessment[];
  readonly attendeeId: number;
  readonly labels: Readonly<Record<string, string>>;
  readonly legs: readonly TransferInput[];
  readonly references: RefundReferences;
  readonly replay: boolean;
};

/** The original group a posted refund leg reverses. Every refund leg the
 * production plan maps carries it, so an absent value is a broken plan. */
export const reversedGroup = (leg: TransferInput): string =>
  requireValue(
    leg.reversesGroup,
    `Posted refund leg names no reversed group ${leg.reference}`,
  );

/** The account refund group a physical event group folds into. Assessments
 * name the booking group their correction legs belong to; a leg without an
 * assessment keeps its own event group. */
export const mergedGroupOf = (fixture: Fixture, eventGroup: string): string =>
  fixture.assessments.find((assessment) => assessment.eventGroup === eventGroup)
    ?.bookingGroup ?? eventGroup;

/** Whether the ledger already holds a refund leg for this group. A refund
 * leg names the physical event group it reverses, so a merged group matches
 * any of the event groups its assessment folds into it. */
export const hasRefundLegs = (
  fixture: Fixture,
  legs: readonly TransferInput[],
  eventGroup: string,
): boolean =>
  legs.some(
    (leg) =>
      isRefundLeg(leg.kind) &&
      mergedGroupOf(fixture, reversedGroup(leg)) === eventGroup,
  );

/** The label a fixture gives one of its account refund groups. */
export const labelFor = (fixture: Fixture, eventGroup: string): string =>
  requireValue(
    fixture.labels[eventGroup],
    `Fixture names no label for group ${eventGroup}`,
  );

/** One booking's provider payment and its sale leg, sharing one event group. */
const bookingLegs = (
  attendeeId: number,
  eventGroup: string,
  amountPaid: number,
  gross: number,
  listingId: number,
  reference: string,
): TransferInput[] => {
  const account = attendeeAccount(attendeeId);
  return [
    {
      amount: amountPaid,
      destination: account,
      eventGroup,
      kind: KIND.payment,
      occurredAt: BOOKING_AT,
      reference: `${reference}-payment`,
      source: WORLD,
    },
    {
      amount: gross,
      destination: revenueAccount(listingId),
      eventGroup,
      kind: KIND.sale,
      occurredAt: BOOKING_AT,
      reference: `${reference}-sale`,
      source: account,
    },
  ];
};

/* The mixed fixture: a fully-paid group and an underfunded group on one
 * attendee. The safe group reverses and the unsafe group waits for review. */
const mixedFixture = async (): Promise<Fixture> => {
  const attendeeId = 9001;
  const safe = await bookingEventGroup("safe-session");
  const unsafe = await bookingEventGroup("unsafe-session");
  const legs: TransferInput[] = [
    ...bookingLegs(attendeeId, safe, 5000, 5000, 1, "safe"),
    ...bookingLegs(attendeeId, unsafe, 1000, 3000, 2, "unsafe"),
  ];
  return {
    assessments: [],
    attendeeId,
    labels: { [safe]: "safe", [unsafe]: "unsafe" },
    legs,
    references: [
      { index: "pi-safe", sessionIds: ["safe-session"] },
      { index: "pi-unsafe", sessionIds: ["unsafe-session"] },
    ],
    replay: true,
  };
};

/* The operator fixture: a group carrying an operator adjustment. It never
 * reverses, and a reference to a missing booking stays unrecorded. */
const operatorFixture = async (): Promise<Fixture> => {
  const attendeeId = 9002;
  const operator = await bookingEventGroup("operator-session");
  const account = attendeeAccount(attendeeId);
  const legs: TransferInput[] = [
    ...bookingLegs(attendeeId, operator, 2000, 2000, 3, "operator"),
    {
      amount: 500,
      destination: WRITEOFF,
      eventGroup: operator,
      kind: KIND.adjustment,
      occurredAt: BOOKING_AT,
      reference: "operator-adjustment",
      source: account,
    },
  ];
  return {
    assessments: [],
    attendeeId,
    labels: { [operator]: "operator" },
    legs,
    references: [
      { index: "pi-operator", sessionIds: ["operator-session"] },
      { index: "pi-missing", sessionIds: ["missing-session"] },
    ],
    replay: false,
  };
};

/* The payment-only fixture: one provider cash leg and nothing else. The
 * whole account reverses as one payment-only group. */
const paymentFixture = async (): Promise<Fixture> => {
  const attendeeId = 9003;
  const payment = await bookingEventGroup("payment-session");
  return {
    assessments: [],
    attendeeId,
    labels: { [payment]: "payment" },
    legs: [
      {
        amount: 2000,
        destination: attendeeAccount(attendeeId),
        eventGroup: payment,
        kind: KIND.payment,
        occurredAt: BOOKING_AT,
        reference: "payment-cash",
        source: WORLD,
      },
    ],
    references: [{ index: "pi-payment", sessionIds: ["payment-session"] }],
    replay: false,
  };
};

/* The tax fixture: a booking merged with its tax correction legs through the
 * assessment rows, so one account refund group spans both event groups. */
const taxFixture = async (): Promise<Fixture> => {
  const attendeeId = 9004;
  const booking = await bookingEventGroup("tax-session");
  const account = attendeeAccount(attendeeId);
  const correction = "tax-correction";
  const basis = { lines: [{ gross: 1000, listingId: 1 }], modifiers: [] };
  const assessments: StoredTaxAssessment[] = [
    {
      attendeeId,
      bookingGroup: booking,
      eventGroup: booking,
      occurredAt: BOOKING_AT,
      state: {
        assessment: assessTax(basis, NO_TAX),
        kind: "active",
        revision: 0,
      },
    },
    {
      attendeeId,
      bookingGroup: booking,
      eventGroup: correction,
      occurredAt: BOOKING_AT,
      state: {
        assessment: assessTax(basis, {
          mode: "calculate_from_total",
          rateBasisPoints: 2000,
        }),
        kind: "active",
        revision: 1,
      },
    },
  ];
  return {
    assessments,
    attendeeId,
    labels: { [booking]: "tax" },
    legs: [
      ...bookingLegs(attendeeId, booking, 1000, 1000, 1, "tax"),
      {
        amount: 167,
        destination: account,
        eventGroup: correction,
        kind: KIND.taxSale,
        occurredAt: BOOKING_AT,
        reference: "tax-sale-1",
        source: revenueAccount(1),
      },
      {
        amount: 167,
        destination: TAX_VAT,
        eventGroup: correction,
        kind: KIND.vat,
        occurredAt: BOOKING_AT,
        reference: "tax-vat-1",
        source: account,
      },
    ],
    references: [{ index: "pi-tax", sessionIds: ["tax-session"] }],
    replay: false,
  };
};

/** The fixture triples, built once on first use. Built lazily so the event
 * groups resolve under the run's encryption key, not the key a fresh module
 * load happens to see. */
export const fixtures = once(
  async (): Promise<readonly Fixture[]> =>
    Promise.all([
      mixedFixture(),
      operatorFixture(),
      paymentFixture(),
      taxFixture(),
    ]),
);
