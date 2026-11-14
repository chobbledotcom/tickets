/** These joins retain the same real rows across the model evidence boundaries. */
import { pick } from "@std/collections";
import { stub } from "@std/testing/mock";
import { buildCapacityCheckedInsert } from "#db/attendees/capacity/checks.ts";
import { execute, executeBatch, queryAllPrimary } from "#db/client.ts";
import { settings } from "#db/settings.ts";
import { getSubscribedRows, type SubscribedRow } from "#db/subscriptions.ts";
import { requireValue } from "#shared/required-value.ts";
import { subscriptionStartOf } from "#shared/stripe/subscription.ts";
import { stripeApi } from "#shared/stripe.ts";
import { withSubscriptionPlan } from "#shared/subscriptions/booking-plan.ts";
import { cancelOwnerSubscription } from "#shared/subscriptions/cancellation.ts";
import type { SubscriptionStart } from "#shared/subscriptions/plan.ts";
import { checkoutCase } from "./cancellation-checkout.ts";
import {
  checkoutPublicKey,
  checkoutReference,
  checkoutStart,
} from "./cancellation-checkout-fixture.ts";
import { checkoutCases, observeCheckout } from "./checkout-provider.ts";
import { providerSubscription, seedBooking } from "./environment.ts";
import { recordPlanObservation } from "./records-facts.ts";
import type { RenewalCase, RenewalPass } from "./renewal-cases.ts";
import type { RenewalFacts } from "./renewal-facts.ts";
import { observePass } from "./renewal-observations.ts";

/** The retry outcomes that the failed-checkout join reads from each attempt. */
const ATTEMPT_FIELDS = [
  "attempt",
  "authorityReturned",
  "confirmed",
  "held",
  "refundBeforeEnd",
  "refundCash",
  "refunds",
] as const;

/** The plan that the supplied provider reply states, under the join names. */
const observedPlanFacts = (start: SubscriptionStart) => ({
  observedAmount: start.amount,
  observedInterval: start.interval,
  observedListing: start.listingId,
  observedStatus: start.status,
  observedSubscription: start.id,
});

/** The stored booking and plan columns that both joins compare. */
const storedRowFacts = (row: SubscribedRow) => {
  const { attendee_id, id, listing_id, quantity, subscription_status } = row;
  return {
    ...recordPlanObservation(row),
    attendee: attendee_id,
    booking: id,
    listing: listing_id,
    quantity,
    status: subscription_status,
  };
};

/** This joins component contracts. It does not execute the HTTP completion route. */
export const observeJourney = async (facts: RenewalFacts): Promise<void> => {
  const example = requireValue(
    checkoutCases().find(
      (item) =>
        item.policy.mode === "add_to_total" &&
        item.policy.rateBasisPoints === 2000 &&
        item.start.status === "active" &&
        item.now === "2024-01-31T10:15:00Z",
    ),
    "The joined checkout has no representative",
  );
  const attendee = 50000;
  const listing = example.start.listingId;
  await seedBooking({
    attendeeId: attendee,
    id: 50000,
    listingId: listing,
    quantity: 0,
  });
  await seedBooking({
    attendeeId: attendee + 1,
    id: 50001,
    listingId: listing + 1,
    quantity: 0,
  });
  await execute("DELETE FROM listing_attendees WHERE id IN (50000, 50001)");
  const observed = await observeCheckout(example, {});
  const { request } = observed;
  const lines = withSubscriptionPlan(
    [
      { listingId: listing, quantity: example.quantity },
      { listingId: listing + 1, quantity: 1 },
    ],
    observed.start,
    example.policy,
  );
  await executeBatch(
    lines.map((line) =>
      buildCapacityCheckedInsert(line, (bind) => bind(attendee)),
    ),
  );
  const capture = async (
    phase: string,
    cancelReturned = false,
  ): Promise<SubscribedRow> => {
    const rows = (await getSubscribedRows()).filter(
      (row) => row.subscription_id === observed.start.id,
    );
    const row = requireValue(rows[0], "The joined subscription row is absent");
    const joined: RenewalFacts["journeys"][number] = {
      ...storedRowFacts(row),
      ...observedPlanFacts(observed.start),
      attendeeAccount: `attendee:${attendee}`,
      cancelReturned,
      checkoutAt: Date.parse(example.now) / 1000,
      expectedAttendee: attendee,
      expectedListing: listing,
      expectedTrialAt: Date.parse(example.next) / 1000,
      inputPrice: example.price,
      inputQuantity: example.quantity,
      listingAccount: `revenue:${listing}`,
      phase,
      projectionCount: rows.length,
      rate: 2000,
      requestedAmount: request.recurringAmount,
      requestedInterval: request.interval,
      requestedListing: request.metadataListing,
      requestedSubscription: request.subscriptionRead,
      trialAt: request.trialEnd,
    };
    facts.journeys.push(joined);
    return row;
  };
  const first = await capture("stored");
  await execute(
    "UPDATE listings SET recurring_price = 9999, recurring_interval = 'year' WHERE id = ?",
    [listing],
  );
  await settings.update.tax({
    mode: "calculate_from_total",
    rateBasisPoints: 5000,
  });
  await capture("edited");
  const cycle = {
    amount: example.start.amount,
    id: "a",
    paidAt: Date.parse(example.next) / 1000,
    reason: "subscription_cycle",
  };
  const firstPass: RenewalPass = {
    fault: false,
    invoices: [cycle],
    observed: "active",
    read: "found",
  };
  const lastPass: RenewalPass = {
    ...firstPass,
    invoices: [
      cycle,
      {
        ...cycle,
        amount: 303,
        id: "last",
        paidAt: Date.parse("2024-03-29T10:15:00Z") / 1000,
      },
    ],
    observed: "canceled",
  };
  const scenario: RenewalCase = {
    name: "joined",
    passes: [firstPass, lastPass],
    price: first.recurring_price,
    tax: first.recurring_tax,
  };
  facts.scenarios.push({
    initialStatus: first.subscription_status,
    scenario: scenario.name,
    steps: 2,
  });
  facts.expected.push(
    { attempt: "joined:0", scenario: "joined" },
    { attempt: "joined:1", scenario: "joined" },
  );
  await observePass(facts, scenario, first, firstPass, 0);
  const active = await capture("renewed");
  let cancelled = false;
  using _cancel = stub(stripeApi, "cancelSubscription", () =>
    Promise.resolve({
      resource: providerSubscription({ ...observed.start, status: "canceled" }),
      status: "found" as const,
    }),
  );
  await observePass(facts, scenario, active, lastPass, 1, async () => {
    cancelled = await cancelOwnerSubscription(active);
  });
  await capture("cancelled", cancelled);
};

/** A real rejected-session retry consumes the plan and charge read from one
 * supplied Stripe subscription and first invoice. The callback reads its rows
 * before the isolated client closes. It never rebuilds the expected outcome. */
export const failedJourneyFacts = async (): Promise<
  RenewalFacts["failedJoins"]
> => {
  const start = checkoutStart();
  const observed = subscriptionStartOf(providerSubscription(start), {
    id: "in_failed_join",
    payments: {
      data: [
        {
          payment: {
            payment_intent: checkoutReference.reference,
            type: "payment_intent",
          },
          status: "paid",
        },
      ],
    },
  });
  const facts: RenewalFacts["failedJoins"] = [];
  await checkoutCase(
    { observedStart: observed.start, retry: true, scenario: "retry" },
    await checkoutPublicKey(),
    "none",
    async (attempt) => {
      const rows = await queryAllPrimary<SubscribedRow>({
        args: [observed.start.id],
        sql: `SELECT booking.id, booking.attendee_id, booking.listing_id, booking.quantity,
              booking.recurring_price, booking.recurring_tax, booking.recurring_interval,
              booking.subscription_id, booking.subscription_status
         FROM listing_attendees AS booking WHERE booking.subscription_id = ?`,
      });
      const row = requireValue(
        rows[0],
        "The failed join lost its retained plan",
      );
      if (rows.length !== 1)
        throw new Error("The failed join has duplicate retained plans");
      const { price, ...stored } = storedRowFacts(row);
      facts.push({
        ...stored,
        ...observedPlanFacts(observed.start),
        ...pick(attempt, ATTEMPT_FIELDS),
        amount: price,
        consumedReference: checkoutReference.reference,
        observedReference: observed.paymentReference,
      });
    },
  );
  return facts;
};
