import type { ModelGuide } from "#scripts/model-guides/types.ts";

/** The everyday story of one subscription row across the scheduled check and
 * the owner cancel. */
/* jscpd:ignore-start -- static data, not code */
export const subscriptionLifecycle: ModelGuide = {
  badOutcome:
    "An ended row holds a paid renewal out of the ledger, or a refused read removes money that the row already holds.",
  cast: [
    {
      meaning:
        "One stored row that links an attendee to a listing and holds the subscription status word.",
      term: "booking row",
    },
    {
      meaning: "The status word in the booking row. It is a database column.",
      term: "stored",
    },
    {
      meaning:
        "The status word that Stripe holds. It is model state, not a database column.",
      term: "provider",
    },
    {
      meaning:
        "One later payment of the plan. The model stops at one renewal for each row.",
      term: "renewal",
    },
    {
      meaning:
        "The transfer rows that record money for the row. The model counts the renewal legs.",
      term: "ledger",
    },
    {
      meaning:
        "One prepared command result. The producer runs the real command before it supplies the values.",
      term: "move",
    },
    {
      meaning:
        "The two status groups. Live has active, incomplete, past_due, paused, trialing, and unpaid. Ended has canceled and incomplete_expired.",
      term: "live and ended",
    },
  ],
  claim:
    "This page follows one booking row through the scheduled check and the owner cancel. A row becomes ended only when Stripe ends and every paid renewal sits in the ledger. The ledger never holds a renewal that Stripe does not hold as paid.",
  limits: [
    "The examples use one row, one month plan of 600 with no tax, at most one renewal, and all eight statuses.",
    "The commands run one after another. A command that overlaps another belongs to SubscriptionCancellation.",
    "Stripe replies are assumptions. The model does not prove provider truth or a provider network.",
    "The model reads one command result. SQL batch atomicity and the real scheduler need separate tests.",
    "The model checks safety. It does not prove that a check runs or that a retry finishes.",
  ],
  module: "SubscriptionLifecycle",
  safety:
    "Every accepted step keeps recorded renewals at or below Stripe's paid renewals. A row that ends has an ended Stripe subscription and all its paid renewals. No command removes a recorded renewal or posts a leg for another row.",
  steps: [
    {
      code: [
        {
          path: "src/shared/subscriptions/plan.ts",
          symbol: "planOfStart",
        },
        {
          path: "scripts/verify-models/subscriptions/lifecycle-facts.ts",
          symbol: "lifecycleCases",
        },
      ],
      rules: ["Init", "TypeOK", "Coverage"],
      title: "Start at the first checkout",
      values: [
        { name: "stored", value: "active" },
        { name: "provider", value: "active" },
        { name: "paid", value: "0" },
        { name: "recorded", value: "0" },
        {
          name: "example domain",
          value:
            "2 commands, 3 Stripe replies, 8 stored statuses, 8 Stripe statuses, and 3 ledger pairs. That makes 1152 moves.",
        },
      ],
      what: "The model starts at the first checkout. The row holds the status that Stripe reported. The plan has no renewal yet. The producer prepares one move for each command, reply, status pair, and ledger pair. Coverage requires every status and each important result to exist. The seed data is not a live subscription.",
    },
    {
      code: [
        {
          detail: "declaration",
          path: "src/shared/subscriptions/plan.ts",
          symbol: "SUBSCRIPTION_NODE_OF",
        },
      ],
      rules: ["ProviderStep"],
      title: "Stripe moves on its own",
      values: [
        { name: "provider", value: "active, then canceled" },
        { name: "paid", value: "0, then 1" },
        { name: "stored", value: "active, unchanged" },
        { name: "recorded", value: "0, unchanged" },
      ],
      what: "Stripe can change a live subscription to any status and can take one renewal payment. This step is an assumption about Stripe. The booking row does not change. A subscription that Stripe ends stays live in the row until a command records the end. An ended Stripe subscription does not change and takes no payment.",
    },
    {
      code: [
        {
          path: "src/shared/subscriptions/record.ts",
          symbol: "recordStripeReport",
        },
        {
          path: "scripts/verify-models/subscriptions/lifecycle-facts.ts",
          symbol: "lifecycleScenario",
        },
      ],
      rules: ["StartsHere", "CommandStep"],
      title: "One move runs at its own position",
      values: [
        { name: "move position", value: "17" },
        {
          name: "state",
          value: "active stored, active provider, 0 paid, 0 recorded",
        },
        { name: "command", value: "check" },
      ],
      what: "The producer lists every expected move before it runs. Each move keeps its position in that list. A move can run only from the state that it started in. The checker applies a move at its own position. A move from another state changes no stored value, and the model still checks that move. The model keeps no second result for one position.",
    },
    {
      code: [
        {
          path: "src/shared/subscriptions/status-check.ts",
          symbol: "runSubscriptionCheck",
        },
        {
          path: "src/shared/subscriptions/record.ts",
          symbol: "recordObserved",
        },
      ],
      rules: ["CommandStep", "MoveLaw"],
      title: "The check records the last renewal with the end",
      values: [
        { name: "command", value: "check" },
        { name: "reply", value: "answers" },
        { name: "stored", value: "active, then canceled" },
        { name: "provider", value: "canceled" },
        { name: "paid", value: "1" },
        { name: "recorded", value: "0, then 1" },
        { name: "outcome", value: "returned" },
      ],
      what: "Stripe ends the subscription after one more paid renewal. The row still says active and holds no renewal. The scheduled check reads the Stripe status and the paid invoices. The write records the renewal and the ended status in one batch. The row can become ended only in a write that also records the renewal.",
    },
    {
      code: [
        {
          path: "src/shared/subscriptions/cancellation.ts",
          symbol: "cancelOwnerSubscription",
        },
        {
          path: "src/features/admin/subscriptions.ts",
          symbol: "adminHandlers",
        },
      ],
      rules: ["MoveLaw"],
      title: "The owner cancels from the Subscriptions page",
      values: [
        { name: "command", value: "cancel" },
        { name: "stored", value: "active" },
        { name: "provider", value: "active, then canceled" },
        { name: "outcome", value: "cancelled" },
        {
          name: "behind case",
          value: "invoice read refused. The row stays active.",
        },
      ],
      what: "The owner cancels one subscription. The production call cancels at Stripe, then records the status and the final paid invoices. A successful write returns cancelled and the row ends. A refused invoice read returns behind. Stripe ended the subscription but the row stays live, so a later check can still record its money. An ended row returns ended and sends no request.",
    },
    {
      code: [
        {
          path: "src/shared/db/subscriptions.ts",
          symbol: "statusWrite",
        },
        {
          path: "src/shared/db/subscriptions.ts",
          symbol: "renewalBookingGuard",
        },
        {
          path: "src/shared/db/subscriptions.ts",
          symbol: "getCheckedRows",
        },
      ],
      rules: ["MoveLaw", "StateSafe"],
      title: "An ended row holds all its money",
      values: [
        { name: "stored", value: "canceled" },
        { name: "provider", value: "canceled" },
        { name: "paid", value: "1" },
        { name: "recorded", value: "1" },
        { name: "refused read", value: "No stored value changes." },
      ],
      what: "The ledger never holds more renewals than Stripe. An ended row needs an ended Stripe subscription and every paid renewal in the ledger. A refused read or a refused write changes no stored value. An ended row takes no command at all. No command posts a leg for another row. The scheduled check reads live rows only.",
    },
    {
      code: [
        {
          path: "src/shared/payment/subscription-machine-spec.ts",
          symbol: "isCancellable",
        },
        {
          path: "src/shared/subscriptions/status-check.ts",
          symbol: "runSubscriptionCheck",
        },
      ],
      rules: ["Safety", "Next"],
      title: "Safety keeps every earlier refusal",
      values: [
        { name: "movesSafe", value: "TRUE" },
        { name: "Next", value: "A Stripe change, one command, or no change." },
      ],
      what: "Safety joins the type bounds, the ledger law, and the memory of every broken move law. A later good move cannot hide an earlier bad result. Next permits a Stripe change, one command, or no change. The model does not require a check to run.",
    },
  ],
  title: "The scheduled check and the owner cancel keep one paid renewal",
};
/* jscpd:ignore-end */
