/** Each operation keeps its scenario and attempt; each read keeps its row slot. */
import type { FactsOf } from "./controls.ts";

/* jscpd:ignore-start -- a list of strings, not code */
const projectionFields = {
  attempt: "Int",
  attendee: "Int",
  booking: "Int",
  interval: "Str",
  listing: "Int",
  pass: "Int",
  price: "Int",
  quantity: "Int",
  scenario: "Str",
  singleMatches: "Bool",
  slot: "Int",
  status: "Str",
  subscription: "Str",
  tax: "Int",
} as const;
export const RECORD_TABLES = {
  expected: ["ExpectedProjection", projectionFields],
  invalid: [
    "InvalidPlans",
    {
      attempt: "Int",
      listThrows: "Bool",
      pass: "Int",
      scenario: "Str",
      singleThrows: "Bool",
    },
  ],
  observed: ["ObservedProjection", projectionFields],
  operations: [
    "OperationFacts",
    {
      accepted: "Bool",
      afterQuantity: "Int",
      afterStatus: "Str",
      applyRan: "Bool",
      attempt: "Int",
      attendee: "Int",
      booking: "Int",
      expectedAccepted: "Bool",
      expectedAttendee: "Int",
      expectedBooking: "Int",
      expectedInterval: "Str",
      expectedListing: "Int",
      expectedPresent: "Bool",
      expectedPrice: "Int",
      expectedQuantity: "Int",
      expectedRowCount: "Int",
      expectedStatus: "Str",
      expectedSubscription: "Str",
      expectedTax: "Int",
      interval: "Str",
      listing: "Int",
      listingRefused: "Bool",
      live: "Bool",
      liveRead: "Bool",
      moneyCorrect: "Bool",
      moneyUnchanged: "Bool",
      operation: "Str",
      pass: "Int",
      present: "Bool",
      price: "Int",
      quantity: "Int",
      recordsUnchanged: "Bool",
      rowCount: "Int",
      scenario: "Str",
      status: "Str",
      subscription: "Str",
      tax: "Int",
      validationAccepted: "Bool",
      validationUnchanged: "Bool",
    },
  ],
} as const;
/* jscpd:ignore-end */

export type RecordFacts = FactsOf<typeof RECORD_TABLES>;

/** Copy stored plan columns without validating or repairing the observation. */
export const recordPlanObservation = (row: {
  recurring_interval: string;
  recurring_price: number;
  recurring_tax: number;
  subscription_id: string;
}): Pick<
  RecordFacts["observed"][number],
  "interval" | "price" | "subscription" | "tax"
> => ({
  interval: row.recurring_interval,
  price: row.recurring_price,
  subscription: row.subscription_id,
  tax: row.recurring_tax,
});

/** Independent business classification, exhaustive over the provider's union. */
export const liveStatus = {
  active: true,
  canceled: false,
  incomplete: true,
  incomplete_expired: false,
  past_due: true,
  paused: true,
  trialing: true,
  unpaid: true,
} as const;
