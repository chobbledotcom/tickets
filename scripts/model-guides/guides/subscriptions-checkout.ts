import type { ModelGuide } from "#scripts/model-guides/types.ts";

/** The two business classes of a stored subscription status. */
/* jscpd:ignore-start -- static data, not code */
export const subscriptionRules: ModelGuide = {
  badOutcome:
    "A model treats an ended subscription as live, or a live subscription as safe to discard.",
  cast: [
    {
      meaning: "One stored value of the subscription status column.",
      term: "status word",
    },
    {
      meaning:
        "A subscription that can still charge the buyer. Its plan must stay with its booking row.",
      term: "live subscription",
    },
    {
      meaning:
        "A subscription that no longer charges. A drop can remove its row or its plan.",
      term: "ended subscription",
    },
    {
      meaning:
        "An edit, a delete, or a merge that removes a booking row or its plan.",
      term: "drop",
    },
  ],
  claim:
    "This page explains the two status classes that every subscription model shares. Six stored words still charge the buyer. Two stored words are ended.",
  limits: [
    "The helper has no state, no start state, and no step relation.",
    "It states two sets of status words. It does not describe a status change or a provider callback.",
    "The blank status word is outside both sets. The records model adds it for an ordinary row.",
    "Each model supplies its own facts and its own safety claim.",
  ],
  module: "SubscriptionRules",
  safety:
    "The helper does not claim safety by itself. It supplies the status classes that a model joins into its own safety rule.",
  steps: [
    {
      code: [],
      rules: ["LiveStatuses"],
      title: "A live word still charges the buyer",
      values: [
        { name: "active", value: "live" },
        { name: "incomplete", value: "live" },
        { name: "past_due", value: "live" },
        { name: "paused", value: "live" },
        { name: "trialing", value: "live" },
        { name: "unpaid", value: "live" },
        { name: "count", value: "six words" },
      ],
      what: "LiveStatuses holds six words. A row with one of these words can still charge the buyer. The booking row must keep the plan, so an edit, a delete, or a merge cannot discard it. This set is a business class, not a copy of a production transition table.",
    },
    {
      code: [],
      rules: ["EndedStatuses"],
      title: "An ended word no longer charges",
      values: [
        { name: "canceled", value: "ended" },
        { name: "incomplete_expired", value: "ended" },
        { name: "count", value: "two words" },
      ],
      what: "EndedStatuses holds two words. A row with one of these words no longer charges. A drop can remove that row or its plan. The helper states the classes only. Each caller owns the facts and the safety claim.",
    },
  ],
  title: "The two business classes of a stored subscription status",
};

/** The story of one subscription checkout and the stored plan that follows it. */
export const subscriptionCheckout: ModelGuide = {
  badOutcome:
    "An unsupported order reaches Stripe, the first payment cites the wrong invoice or intent, or the plan lands on another person's row or the wrong row.",
  cast: [
    {
      meaning:
        "The first payment of a subscription. It starts one subscription and charges the tickets at once.",
      term: "checkout",
    },
    {
      meaning:
        "The decision that an order can reach a checkout, and that a subscription can start.",
      term: "admission",
    },
    {
      meaning:
        "The Stripe checkout request, with its one-time lines, its one recurring line, and its interval.",
      term: "request",
    },
    {
      meaning:
        "The stored columns on one booking row. They state the provider id, status, period amount, VAT amount, and interval.",
      term: "plan",
    },
    {
      meaning:
        "One prepared example record from the producer. It is not a live Stripe reply.",
      term: "fact",
    },
    {
      meaning:
        "The scenario name or row name that ties one fact to its expected outcome.",
      term: "identity",
    },
    {
      meaning: "The model memory of any failed business law.",
      term: "verdict",
    },
  ],
  claim:
    "This page follows one subscription checkout from order admission to the stored plan. An admitted subscription order reaches Stripe with one recurring line and the first invoice reference. Every booking row keeps the plan of its own start, with VAT inside the recurring amount.",
  limits: [
    "The examples use synthetic orders and a local Stripe client. No live Stripe reply is observed.",
    "Expected money uses integer minor units from supplied inputs. The model does not prove that Stripe accepts those prices.",
    "The model uses literal UTC calendar dates. It does not call the production date code.",
    "The model checks the supplied finite facts. It does not prove a network race, an order that a scheduler chooses, or a full callback replay.",
    "The model does not prove that a checkout finishes or that a webhook later arrives.",
    "SQL atomicity and the local database remain assumptions.",
  ],
  module: "SubscriptionCheckout",
  safety:
    "Every observed admission fact obeys the order gate. Every request fact has one recurring line for the whole quantity and the first-invoice reference. Every stored row keeps its own exact plan. Any failed law stays visible.",
  steps: [
    {
      code: [
        {
          path: "scripts/verify-models/subscriptions/checkout-facts.ts",
          symbol: "CHECKOUT_TABLES",
        },
      ],
      rules: ["Init", "TypeOK", "SelectedIdentity"],
      title: "Start before any observed event",
      values: [
        { name: "checksPassed", value: "TRUE" },
        { name: "selected", value: "none" },
        { name: "selectionKind", value: "none" },
        { name: "selectionIndex", value: "0" },
        { name: "attempt", value: "0" },
      ],
      what: "The model starts with no selected fact. Coverage checks the prepared facts one time and stores the answer in checksPassed. TypeOK keeps the table name and its one-based index in step. SelectedIdentity reads the identity of the selected row. The words none and zero are model memory, not event ids.",
    },
    {
      code: [
        {
          path: "src/shared/subscriptions/checkout-rules.ts",
          symbol: "subscriptionCheckoutError",
        },
        {
          path: "src/shared/subscriptions/checkout-rules.ts",
          symbol: "subscriptionOrderError",
        },
      ],
      rules: ["AdmissionLaw", "AdmissionStep"],
      title: "An order must pass the admission gate",
      values: [
        {
          name: "stripe-extra",
          value:
            "Provider stripe, one subscription line, own row TRUE, total 2000. Checkout accepted TRUE. Order accepted TRUE.",
        },
        {
          name: "square-single",
          value:
            "Provider square, one subscription line. Checkout accepted FALSE. Order accepted FALSE.",
        },
        {
          name: "none-ordinary",
          value:
            "No subscription line, total 0. Checkout accepted TRUE. Order accepted TRUE.",
        },
        {
          name: "stripe-zero",
          value:
            "One subscription line, total 0. Checkout accepted TRUE. Order accepted FALSE.",
        },
        {
          name: "stripe-deposit",
          value:
            "A deposit changes the first payment to 100. Admission still passes with one subscription line.",
        },
      ],
      what: "The admission rule reads one order. An ordinary order with no subscription line passes. A subscription order passes only with the stripe provider, one subscription line, and a row that the order books on its own. The order gate also needs a total above zero. A deposit changes the first payment only, so it does not change this decision. The step records the observed verdict and keeps any earlier failure.",
    },
    {
      code: [
        {
          path: "src/shared/stripe.ts",
          symbol: "stripeApi",
        },
        {
          path: "src/shared/payment/checkout-session.ts",
          symbol: "makeCreateCheckoutSession",
        },
        {
          path: "src/shared/subscriptions/plan.ts",
          symbol: "firstRecurringChargeAt",
        },
        {
          path: "src/shared/stripe/subscription.ts",
          symbol: "subscriptionStartOf",
        },
      ],
      rules: ["RequestLaw", "RequestStep"],
      title: "The Stripe request names one recurring line",
      values: [
        {
          name: "checkout-1 interval",
          value:
            "week. The recurring amount is 1002 minor units for two places.",
        },
        {
          name: "checkout-1 first payment",
          value: "2137 minor units on 2 one-time lines.",
        },
        {
          name: "checkout-1 trial end",
          value: "2027-01-04T10:15:00Z from the start 2026-12-28T10:15:00Z.",
        },
        {
          name: "checkout-10 interval",
          value:
            "month. The start 2026-01-31T10:15:00Z gives the trial end 2026-02-28T10:15:00Z.",
        },
        {
          name: "checkout-25 interval",
          value:
            "year. The leap-day start 2024-02-29T10:15:00Z gives the trial end 2025-02-28T10:15:00Z.",
        },
        {
          name: "identities",
          value:
            "request_1, session cs_model_1, first invoice in_first_1, reference pi_first_1.",
        },
      ],
      what: "The request rule reads the composed Stripe request. The mode is subscription. The request has one recurring line with quantity one. That line charges the whole recurring amount and names the subscribed listing in its metadata. The one-time lines charge the first payment. The trial end is one period after the start. The payment reference comes from the first invoice of this session, not a later renewal. The request id, the session id, and the first invoice id stay apart.",
    },
    {
      code: [
        {
          path: "src/shared/subscriptions/booking-plan.ts",
          symbol: "withSubscriptionPlan",
        },
        {
          path: "src/shared/db/attendees/capacity/checks.ts",
          symbol: "buildCapacityCheckedInsert",
        },
        {
          path: "src/shared/tax/assessment.ts",
          symbol: "assessTax",
        },
      ],
      rules: ["PlanLaw", "PlanStep"],
      title: "The plan stays on the row that started it",
      values: [
        {
          name: "checkout-1 own row",
          value:
            "Row 105 keeps 1002 minor units, VAT 0, interval week, status active, provider sub_model_1.",
        },
        {
          name: "checkout-10 own row",
          value:
            "Row 1005 keeps 501 minor units, VAT 251, interval month, status canceled, provider sub_model_10.",
        },
        {
          name: "checkout-10 control row",
          value:
            "Row 1000 keeps provider sub_other_10, 333 minor units, VAT 55, interval year, status canceled.",
        },
        {
          name: "after a listing edit",
          value:
            "Row 1005 still keeps 501 minor units and the month interval while its listing states 9999 and week.",
        },
      ],
      what: "The plan rule reads every stored row, not only the subscribed row. The plan goes on the own row of the subscribed listing. An extra ordinary line, a package row, and an add-on child row keep no plan. The plan amount is the whole recurring charge, and the tax is the VAT inside that amount. A later listing edit or a change to the tax policy cannot move a plan that is already stored. An ended status still keeps its plan columns.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/subscriptions/checkout.ts",
          symbol: "checkoutFacts",
        },
        {
          path: "scripts/verify-models/subscriptions/checkout-admission.ts",
          symbol: "admissionFacts",
        },
      ],
      rules: [
        "Coverage",
        "IdentityCoverage",
        "AdmissionScenarioOf",
        "RequestScenarioOf",
        "PlanIdentityOf",
      ],
      title: "Every prepared input has one outcome",
      values: [
        {
          name: "admission facts",
          value: "40 rows from 4 providers and 10 order shapes.",
        },
        {
          name: "request facts",
          value: "40 rows from 5 start dates and 8 status words.",
        },
        {
          name: "plan facts",
          value: "516 rows from 43 examples, 6 rows each, in 2 read stages.",
        },
        {
          name: "required witnesses",
          value:
            "stripe-extra accepted, stripe-deposit accepted, square-package refused, stripe-quantity-two accepted.",
        },
        {
          name: "local-41",
          value:
            "An owned plan row with quantity 0. The amount is 0 minor units.",
        },
      ],
      what: "The coverage rule compares three prepared universes with the observed facts. Each universe lists every expected identity before a read. A row must carry an expected name, and each expected name needs one row. Equal counts also stop two different outcomes for one identity. Coverage also requires each important shape to occur. The interval set must hold week, month, and year. The tax mode set must hold none, add_to_total, and calculate_from_total. The status set must hold all eight words. One owned plan row must hold zero places.",
    },
    {
      code: [
        {
          path: "src/shared/stripe-provider.ts",
          symbol: "stripePaymentProvider",
        },
      ],
      rules: ["Next", "Safety"],
      title: "A failed law stays failed",
      values: [
        { name: "good fact", value: "checksPassed TRUE, then TRUE." },
        {
          name: "square-single with order accepted TRUE",
          value: "The admission law fails. checksPassed becomes FALSE.",
        },
        {
          name: "later good fact",
          value: "checksPassed stays FALSE.",
        },
        { name: "no event", value: "Every value keeps its current state." },
      ],
      what: "The step relation selects any prepared fact or changes nothing. Each selected fact must pass its law. A fact that passes keeps checksPassed TRUE. A fact that fails sets checksPassed FALSE. A later fact that passes cannot clear that value. Safety requires TypeOK and checksPassed. The model does not force a checkout event to occur.",
    },
  ],
  title: "One subscription checkout and the plan that it stores",
};
/* jscpd:ignore-end */
