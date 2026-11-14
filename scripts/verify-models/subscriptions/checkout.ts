/** Production-backed checkout evidence. No live provider or application DB is used. */
import { tlaModule, tlaStringSet } from "#scripts/verify-models/data.ts";
import type { SubscriptionStart } from "#shared/subscriptions/plan.ts";
import { admissionFacts } from "./checkout-admission.ts";
import { CHECKOUT_TABLES, type CheckoutFacts } from "./checkout-facts.ts";
import {
  type CheckoutBoundary,
  type CheckoutCase,
  checkoutCases,
  observeCheckout,
} from "./checkout-provider.ts";
import { observePlans } from "./checkout-storage.ts";
import { type Faults, producerFor, recordSetsFor } from "./controls.ts";
import { withSubscriptionDb } from "./environment.ts";

/** Uncached: injected client replies and SQL writes reach extraction on each call. */
export const checkoutFacts = (
  boundary: CheckoutBoundary = {},
): Promise<CheckoutFacts> =>
  withSubscriptionDb(async () => {
    const admissions = admissionFacts();
    const facts: CheckoutFacts = {
      admissions: admissions.facts,
      admissionUniverse: admissions.universe,
      plans: [],
      planUniverse: [],
      requests: [],
      requestUniverse: [],
    };
    const storePlans = async (
      example: CheckoutCase,
      start: SubscriptionStart,
    ): Promise<void> => {
      const plans = await observePlans(example, start, boundary);
      facts.plans.push(...plans.facts);
      facts.planUniverse.push(...plans.universe);
    };
    const cases = checkoutCases();
    for (const example of cases) {
      facts.requestUniverse.push(example.scenario);
      const observed = await observeCheckout(example, boundary);
      facts.requests.push(observed.request);
      await storePlans(example, observed.start);
    }
    const first = cases[0];
    if (first === undefined) throw new Error("Checkout has no calendar domain");
    // These supplied amounts check local attachment arithmetic, not Stripe price
    // acceptance. A quantity-zero retained row can still have a live plan.
    for (const [offset, amount] of [0, 3, 9007199254740000].entries()) {
      const index = cases.length + offset + 1;
      const start = {
        ...first.start,
        amount,
        id: `sub_local_${index}`,
        listingId: index * 10 + 1,
      };
      const example = {
        ...first,
        index,
        policy: {
          mode: "calculate_from_total",
          rateBasisPoints: offset === 1 ? 10000 : 0,
        } as const,
        quantity: 0,
        scenario: `local-${index}`,
        start,
      };
      await storePlans(example, start);
    }
    return facts;
  });

const recordSets = recordSetsFor(CHECKOUT_TABLES);
const moduleFor = (facts: CheckoutFacts): string =>
  tlaModule("SubscriptionCheckoutData", [
    tlaStringSet("AdmissionUniverse", facts.admissionUniverse),
    tlaStringSet("RequestUniverse", facts.requestUniverse),
    tlaStringSet("PlanUniverse", facts.planUniverse),
    ...recordSets(facts),
  ]);

/* jscpd:ignore-start -- a list of strings, not code */
const editedPlan = { owned: "true", scenario: "checkout-1", stage: "edited" };
const firstRequest = { scenario: "checkout-1" };
const FAULTS: Faults = {
  fields: [
    [
      "unsupported-order-admitted",
      "admissions",
      "orderAccepted",
      "",
      { provider: "square", shape: "single" },
    ],
    [
      "wrong-booking-attribution",
      "plans",
      "subscription",
      "sub_stolen",
      { identity: "checkout-1-stored-101" },
    ],
    ["rewritten-plan-amount", "plans", "amount", "", editedPlan],
    ["wrong-plan-id", "plans", "subscription", "sub_wrong", editedPlan],
    ["wrong-frozen-vat", "plans", "tax", "", editedPlan],
    ["wrong-plan-status", "plans", "status", "sub_wrong", editedPlan],
    ["wrong-plan-interval", "plans", "interval", "sub_wrong", editedPlan],
    ["wrong-initial-quantity", "requests", "initialQuantity", "", firstRequest],
    ["wrong-recurring-interval", "requests", "interval", "wrong", firstRequest],
    ["wrong-invoice-read", "requests", "invoiceRead", "wrong", firstRequest],
    ["wrong-request-listing", "requests", "metadataListing", "", firstRequest],
    ["wrong-initial-amount", "requests", "oneTimeAmount", "", firstRequest],
    ["missing-one-time-line", "requests", "oneTimeLines", "", firstRequest],
    [
      "wrong-ordinary-initial-line",
      "requests",
      "ordinaryInitial",
      "",
      firstRequest,
    ],
    [
      "wrong-first-invoice-reference",
      "requests",
      "paymentReference",
      "wrong",
      firstRequest,
    ],
    ["wrong-recurring-amount", "requests", "recurringAmount", "", firstRequest],
    ["extra-recurring-line", "requests", "recurringLines", "", firstRequest],
    [
      "wrong-recurring-quantity",
      "requests",
      "recurringQuantity",
      "",
      firstRequest,
    ],
    [
      "wrong-subscribed-initial-line",
      "requests",
      "subscribedInitial",
      "",
      firstRequest,
    ],
    [
      "wrong-subscription-read",
      "requests",
      "subscriptionRead",
      "wrong",
      firstRequest,
    ],
    ["wrong-recurring-time", "requests", "trialEnd", "", firstRequest],
  ],
  missing: [
    [
      "missing-refused-outcome",
      "initial",
      "admissions",
      { scenario: "stripe-deposit" },
    ],
    [
      "missing-booking-outcome",
      "initial",
      "plans",
      { identity: "checkout-1-stored-100" },
    ],
  ],
};
/* jscpd:ignore-end */

export const { controls, modelData } = producerFor(
  checkoutFacts,
  moduleFor,
  ({ admissions, plans, requests }) => ({ admissions, plans, requests }),
  FAULTS,
  () => [],
);
