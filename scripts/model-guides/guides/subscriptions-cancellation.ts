import type { ModelGuide } from "#scripts/model-guides/types.ts";

/** The everyday story of an owner cancel and a failed checkout refund. */
/* jscpd:ignore-start -- static data, not code */
export const subscriptionCancellation: ModelGuide = {
  badOutcome:
    "A row ends while Stripe still charges, or a replay sends a second refund for one failed checkout.",
  cast: [
    {
      meaning:
        "One stored row that links an attendee to a listing and holds the subscription plan.",
      term: "booking row",
    },
    {
      meaning:
        "The subscription id, price, tax, and period on the booking row, frozen at checkout.",
      term: "plan",
    },
    {
      meaning:
        "A durable row that holds the right to finish one refund. A held anchor permits a later delivery to continue.",
      term: "payment anchor",
    },
    {
      meaning:
        "One paid charge in the last billing period. The owner examples use two final invoices of 600 each.",
      term: "final invoice",
    },
    {
      meaning:
        "One transfer row with a source account, a destination account, an amount, and a reference.",
      term: "ledger leg",
    },
    {
      meaning:
        "One run of the callback for one scenario. A repeated scenario has three deliveries on one retained database.",
      term: "delivery",
    },
    {
      meaning:
        "A status write that changes a row only when the stored status still matches the value that the caller read.",
      term: "guarded write",
    },
  ],
  claim:
    "This page follows an owner cancel and a failed checkout. An owner cancel records the final renewals before the row ends. A failed checkout keeps its zero-quantity plan, ends Stripe, and refunds at most once. A replay finishes stored work without a second provider refund.",
  limits: [
    "The examples use synthetic GBP charges of 600, two final renewals of 600, one month plan, all eight statuses, and selected interruptions.",
    "Provider replies are assumptions. They must be truthful and belong to the requested subscription id.",
    "The model assumes successful SQLite commit atomicity. It does not prove a real concurrent database race.",
    "The model does not prove provider network behavior, authentication, scheduler liveness, or Stripe truth.",
    "Other models check money arithmetic, checkout admission, and record edits.",
  ],
  module: "SubscriptionCancellation",
  safety:
    "An ended row follows an ended Stripe subscription and its final renewal money. A refund follows a confirmed external end. A replay keeps one refund and one refund leg.",
  steps: [
    {
      code: [
        {
          path: "scripts/verify-models/subscriptions/cancellation-facts.ts",
          symbol: "CANCELLATION_TABLES",
        },
        {
          path: "scripts/verify-models/subscriptions/cancellation-checkout-fixture.ts",
          symbol: "checkoutStart",
        },
      ],
      rules: ["Init", "TypeOK"],
      title: "Start before any observation",
      values: [
        { name: "scenario", value: "none" },
        { name: "scenarioKind", value: "none" },
        { name: "scenarioIndex", value: "0" },
        { name: "attempt", value: "0" },
        { name: "allAttemptsSafe", value: "TRUE" },
      ],
      what: "The model starts before it applies any observed fact. It does not start from an empty application row. The producer runs each scenario in an isolated database. TypeOK bounds the selected table and index. The checkout fixture supplies a trialing subscription sub_failed for 600 GBP.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/subscriptions/cancellation.ts",
          symbol: "cancellationFacts",
        },
        {
          path: "scripts/verify-models/subscriptions/cancellation-owner.ts",
          symbol: "ownerFacts",
        },
        {
          path: "scripts/verify-models/subscriptions/cancellation-checkout.ts",
          symbol: "checkoutFacts",
        },
      ],
      rules: ["Coverage", "RepeatedScenarios", "ScenarioIdentity"],
      title: "Every input needs exactly one fact",
      values: [
        { name: "owner facts", value: "27" },
        { name: "checkout facts", value: "39" },
        { name: "write facts", value: "384" },
        {
          name: "repeated scenarios",
          value: "retry, placeholder, ledger-interrupted, anchorless",
        },
        {
          name: "write domain",
          value: "6 live snapshots, 8 before statuses, 8 target statuses",
        },
      ],
      what: "Coverage requires one fact for each expected input. The owner set has 27 scenarios. The checkout set has 31 single-delivery scenarios plus 4 repeated scenarios with 3 deliveries each, which makes 39 facts. The write set has 6 live snapshots, 8 before statuses, and 8 target statuses, which makes 384 facts. RepeatedScenarios names the four cases with three deliveries. ScenarioIdentity joins the selected table index back to the full scenario name. Coverage also requires each important answer to exist.",
    },
    {
      code: [
        {
          path: "src/shared/subscriptions/cancellation.ts",
          symbol: "cancelOwnerSubscription",
        },
        {
          path: "src/shared/subscriptions/record.ts",
          symbol: "recordObserved",
        },
        {
          detail: "declaration",
          path: "src/shared/subscriptions/plan.ts",
          symbol: "SUBSCRIPTION_NODE_OF",
        },
      ],
      rules: ["OwnerStep", "SafeOwner"],
      title: "The owner cancel records both the end and the money",
      values: [
        { name: "final invoices", value: "2 at 600 each" },
        { name: "cash", value: "1200" },
        { name: "legs", value: "4" },
        { name: "row after", value: "canceled" },
        {
          name: "behind case",
          value: "invoice read refused. The row stays live.",
        },
      ],
      what: "The owner cancels from the Subscriptions page. The production call cancels at Stripe, or reads the current status when the cancel is refused. A successful read records the final paid invoices and the ended status. The example has two final invoices of 600 each. The row then holds 1200 cash across 4 legs and the status canceled. The answer is cancelled only when the row holds the end. A refused invoice read returns behind and leaves the row live. The final invoices keep separate ids and event groups, so two equal payments cannot merge.",
    },
    {
      code: [
        { path: "src/shared/db/subscriptions.ts", symbol: "statusWrite" },
        {
          path: "scripts/verify-models/subscriptions/cancellation-owner.ts",
          symbol: "guardedWriteFacts",
        },
        {
          path: "src/shared/db/subscriptions.ts",
          symbol: "getSubscribedRowOrNull",
        },
      ],
      rules: ["WriteStep", "SafeWrite"],
      title: "A stale live write changes no row",
      values: [
        { name: "snapshot", value: "active" },
        { name: "before", value: "canceled" },
        { name: "target", value: "active" },
        { name: "affected", value: "0. The row stays canceled." },
        {
          name: "live to ended",
          value: "active before, canceled target, affected 1",
        },
      ],
      what: "The status write compares the row state. An ended target replaces any live status. A live target replaces only the status that the caller read. The example tries a live target on a row that a cancel already ended. The update changes zero rows and the row stays canceled. A zero-row update is a normal refusal, not an exception. The model runs every combination of live snapshot, stored status, and target.",
    },
    {
      code: [
        {
          path: "src/features/api/payment-processing/rejected-subscription.ts",
          symbol: "settleRejectedSubscription",
        },
        {
          path: "src/features/api/payment-processing/placeholder-resume.ts",
          symbol: "finishPlaceholderRefund",
        },
      ],
      rules: ["CheckoutStep", "SafeCheckout"],
      title: "A failed checkout keeps its plan and stops Stripe",
      values: [
        { name: "attempt", value: "1" },
        { name: "quantity", value: "0" },
        { name: "plan rows", value: "1. The plan is kept." },
        { name: "refunds", value: "0" },
        { name: "held", value: "1" },
        { name: "authority returned", value: "0" },
      ],
      what: "A stored failed checkout keeps a plan with quantity zero. The callback stores the plan before it ends Stripe. The end must come before any refund. Delivery one holds the payment anchor and sends no refund. The row stays at quantity zero for a person to inspect. A booked row, an orphaned sale, an occupied callback, or a foreign proof permits no cancel and no refund.",
    },
    {
      code: [
        {
          path: "src/features/api/payment-processing/placeholder-completion.ts",
          symbol: "completePlaceholderMoney",
        },
        {
          path: "src/features/api/payment-processing/rejected-money.ts",
          symbol: "completeRejectedMoney",
        },
        {
          path: "src/shared/payment/refund-authority.ts",
          symbol: "markRefundCompleted",
        },
      ],
      rules: ["SafeCheckout"],
      title: "A retry finishes one refund",
      values: [
        { name: "attempt 2", value: "refunds 1, cash 600, legs 1, held 0" },
        { name: "attempt 3", value: "refunds 1. No second provider refund." },
        {
          name: "anchorless retry",
          value: "throws on a later delivery without a held anchor",
        },
      ],
      what: "A later delivery repeats the same work. The second delivery ends Stripe and records one 600 refund. The third delivery repeats the same result and keeps one refund. No second provider refund appears in the facts. An anchorless failure sends no refund. A later anchorless delivery throws and calls no provider. A failed checkout that names a charge needs a held anchor at its cancel.",
    },
    {
      code: [
        {
          path: "src/shared/db/subscriptions.ts",
          symbol: "getSubscribedRowOrNull",
        },
        {
          path: "src/shared/payment/refund-authority.ts",
          symbol: "markRefundLocalRecorded",
        },
      ],
      rules: ["Safety", "Next"],
      title: "Safety joins every observed answer",
      values: [
        { name: "allAttemptsSafe", value: "TRUE" },
        {
          name: "Next",
          value: "An owner fact, a write fact, a checkout fact, or no change.",
        },
      ],
      what: "Safety joins the type bounds with the memory of every bad observed result. The initial state sets allAttemptsSafe from Coverage, so a missing owner, checkout, or write fact fails at once. Next permits one owner fact, one write fact, one checkout evidence row, or no change. The model permits a pause. It does not require a retry to run.",
    },
  ],
  title: "One owner cancel and one failed checkout refund",
};
/* jscpd:ignore-end */
