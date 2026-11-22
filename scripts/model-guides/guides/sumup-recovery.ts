import type { ModelGuide } from "#scripts/model-guides/types.ts";

/** A lost SumUp callback must not discard a checkout with money risk. */
/* jscpd:ignore-start -- static data, not code */
export const sumupRecovery: ModelGuide = {
  badOutcome:
    "An old waiting or owed row is deleted, so a paid checkout leaves no row and no later check can find the money.",
  cast: [
    {
      meaning:
        "One attempt to pay for a reservation. Its SumUp checkout id lets the site ask about it.",
      term: "checkout",
    },
    {
      meaning:
        "A provider message about a checkout. A lost callback does not prove that nobody paid.",
      term: "callback",
    },
    {
      meaning:
        "A local row that keeps the checkout so a later task can ask SumUp again.",
      term: "recovery row",
    },
    {
      meaning:
        "The five row labels: staged, waiting, owed, finished, and unpaid.",
      term: "state",
    },
    {
      meaning:
        "One label for unaccounted money risk: no, unknown, or yes. It is not an amount.",
      term: "money answer",
    },
    {
      meaning:
        "One prepared row move with the state and checkout id shape on each side.",
      term: "move",
    },
  ],
  claim:
    "This page follows one SumUp checkout after the provider callback fails to arrive. A row that can still hold unaccounted money stays. It keeps a check that can ask SumUp again. Age alone never proves that nobody paid.",
  limits: [
    "The model uses five states and one representative id or empty id for each state.",
    "Provider event truth and the money labels are assumptions.",
    "Refused table cells supply no move. The model does not check each refusal result.",
    "SQL races, real task clocks, provider truth, and eventual work need separate tests.",
    "No amount, currency, or balance appears in this model.",
  ],
  module: "SumupRecovery",
  safety:
    "Every row with unknown or owed money stays retained and keeps an enabled check. A checkout id is present in every state except staged. Paid evidence ends in owed or finished. A terminal result never changes. No row with money risk is deleted.",
  steps: [
    {
      code: [
        {
          path: "src/shared/payment/sumup-recovery-machine-spec.ts",
          symbol: "RECOVERY_STATE_WITHOUT_CHECKOUT_ID",
        },
        {
          path: "src/shared/payment/sumup-recovery-machine-spec.ts",
          symbol: "RECOVERY_NODES",
        },
      ],
      rules: [
        "Init",
        "TypeOK",
        "CheckoutIdentityConsistent",
        "RepresentativeFacts",
      ],
      title: "Start with a staged row",
      values: [
        { name: "recoveryState", value: "staged" },
        { name: "hasCheckoutId", value: "FALSE" },
        { name: "rowRetained", value: "TRUE" },
        { name: "pruningAgeReached", value: "FALSE" },
        { name: "firstTerminalState", value: "none" },
      ],
      what: "The row starts as staged, before SumUp gives it a checkout id. It is retained and young. The reader agrees that this state carries no id. The producer supplies one row shape for each state.",
    },
    {
      code: [
        {
          path: "src/shared/payment/sumup-recovery-machine-spec.ts",
          symbol: "recoveryRowAfter",
        },
        {
          path: "src/shared/payment/sumup-recovery-machine-spec.ts",
          symbol: "RECOVERY_MOVES",
        },
        {
          path: "src/shared/payment/sumup-recovery-machine-spec.ts",
          symbol: "recoveryMoveTo",
        },
      ],
      rules: [
        "RecoveryStep",
        "MoneySemantics",
        "RiskStates",
        "TerminalStates",
        "MoneyStates",
        "CheckPreservesWork",
      ],
      title: "Creation gives an id and a check gives an answer",
      values: [
        {
          name: "checkout_created",
          value: "staged changes to waiting",
        },
        {
          name: "checkout id",
          value: "empty changes to sumup-checkout-id",
        },
        { name: "waiting money answer", value: "unknown" },
        {
          name: "read_paid_unsettled",
          value: "waiting changes to owed, money answer yes",
        },
        {
          name: "read_expired_or_failed",
          value: "waiting changes to unpaid, money answer no",
        },
        {
          name: "read_paid_settled",
          value: "waiting changes to finished, money answer no",
        },
      ],
      what: "Creation gives the row a provider checkout id and moves it to waiting. A check then supplies an answer. A check must leave the next state checkable or terminal with no money answer. The money labels state risk, not an amount.",
    },
    {
      code: [
        {
          path: "src/shared/payment/sumup-recovery-machine-spec.ts",
          symbol: "recoveryMoveTo",
        },
        {
          path: "src/shared/payment/sumup-recovery-machine-spec.ts",
          symbol: "RECOVERY_CHECKABLE_NODES",
        },
      ],
      rules: ["HasEnabledCheck", "RiskyMoneyKeepsQueuedWork", "RiskStates"],
      title: "A risky row stays in the queue",
      values: [
        { name: "checkable states", value: "waiting and owed" },
        {
          name: "waiting with an id",
          value: "Retained and has check moves.",
        },
        {
          name: "owed with an id",
          value: "Retained and has check moves.",
        },
        {
          name: "finished with an id",
          value: "Terminal. No check move remains.",
        },
      ],
      what: "Waiting and owed are the risk states. Each one has at least one supplied check edge with its id shape. The safety rule requires the row to stay retained and the check to stay enabled. The model proves that an option exists, not that a worker takes it.",
    },
    {
      code: [
        {
          path: "src/shared/payment/sumup-recovery-machine-spec.ts",
          symbol: "RECOVERY_MOVES",
        },
        {
          path: "src/shared/payment/sumup-recovery-machine-spec.ts",
          symbol: "recoveryMoveTo",
        },
      ],
      rules: ["PaidAndTerminalEvidencePreserved", "FirstTerminalResult"],
      title: "Money evidence sticks",
      values: [
        {
          name: "owed with read_paid_booked",
          value: "finished. owedStateSeen stays TRUE.",
        },
        {
          name: "first terminal state",
          value: "finished stays finished after a later move.",
        },
        {
          name: "owed with read_pending",
          value: "No move. The table has no cell.",
        },
        {
          name: "finished or unpaid",
          value: "No move. The result is closed.",
        },
      ],
      what: "Paid evidence permits only owed or finished. The first terminal state survives later contradictions. The producer supplies refused cells as no move, so the table cannot return a row to waiting. This rule also keeps the memory of paid but unaccounted money.",
    },
    {
      code: [
        {
          path: "src/shared/payment/sumup-recovery-machine-spec.ts",
          symbol: "RECOVERY_PRUNABLE_NODES",
        },
        {
          path: "src/shared/payment/sumup-recovery-machine-spec.ts",
          symbol: "RECOVERY_NODES",
        },
      ],
      rules: ["Age", "Prune"],
      title: "Age and cleanup",
      values: [
        {
          name: "prunable states",
          value: "staged, unpaid, and finished",
        },
        {
          name: "staged and old",
          value: "rowRetained FALSE. No money risk.",
        },
        {
          name: "waiting or owed and old",
          value: "No delete. The state is not prunable.",
        },
      ],
      what: "Age only marks the cleanup threshold. Prune deletes a retained row only in a declared prunable state. Staged, unpaid, and finished are prunable. Waiting and owed are not. A bad label becomes visible because Prune does not use money safety as a precondition.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/sumup.ts",
          symbol: "sumupModelData",
        },
        {
          path: "scripts/verify-models/sumup.ts",
          symbol: "corruptSumupData",
        },
      ],
      rules: ["Safety", "Next"],
      title: "Safety joins the rules",
      values: [
        {
          name: "safe run",
          value: "checkoutIdAgrees TRUE and riskyDeletionSeen FALSE.",
        },
        {
          name: "lost identity",
          value: "checkoutIdAgrees FALSE. Safety fails.",
        },
        {
          name: "deleted risky row",
          value: "riskyDeletionSeen TRUE. Safety fails.",
        },
      ],
      what: "Safety joins the money meaning, representative facts, identity agreement, work retention, and evidence histories. A pause is permitted. The model checks every supplied move from any safe state, so it covers any finite order of these events.",
    },
  ],
  title: "Keeping a SumUp checkout recoverable when its callback is lost",
};
/* jscpd:ignore-end */
