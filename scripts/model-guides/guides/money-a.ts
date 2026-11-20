import type { ModelGuide } from "#scripts/model-guides/types.ts";

/** One temporary payment row and one durable refund request. */
/* jscpd:ignore-start -- static data, not code */
export const jointState: ModelGuide = {
  badOutcome:
    "A callback deletes the temporary row while local refund records are still due. Or a row claim or a refund request appears before the payment reference.",
  cast: [
    {
      meaning:
        "One stored payment row that keeps local work for one checkout attempt.",
      term: "temporary row",
    },
    {
      meaning:
        "One worker's control of a row's work. A claim is not evidence of a refund.",
      term: "claim",
    },
    {
      meaning:
        "The durable record that controls one refund request. It keeps the request identity and the evidence for the next action.",
      term: "refund authority",
    },
    {
      meaning:
        "The indexed provider payment reference. The model records only its presence.",
      term: "reference",
    },
    {
      meaning:
        "A lifecycle label that permits row deletion because the refund is complete and the local records are done.",
      term: "prunable",
    },
    {
      meaning:
        "One prepared abstract record from the producer. The fact is not a live customer row.",
      term: "fact",
    },
  ],
  claim:
    "This page follows one temporary payment row and one durable refund request. A row claim or an existing request needs the payment reference first. Row deletion happens only after the provider cash returns and the local records are complete.",
  limits: [
    "The model has one implicit provider-qualified request. It has no amount, actual key, generation number, timestamp or SQL transaction.",
    "It assumes representative coverage and indexed-reference admission. It does not write a unique index.",
    "It proves safety of the supplied abstract edges. It does not prove every concrete state, provider truth, a concurrent write or refund completion.",
    "The row labels combine live work. They do not report provider cash by themselves.",
  ],
  module: "JointState",
  safety:
    "Every accepted step keeps both reference rules, the four send and replay verdicts and the deletion boundary. A deleted row has a prunable request.",
  steps: [
    {
      code: [
        {
          path: "scripts/verify-models/model.ts",
          symbol: "paymentModel",
        },
      ],
      rules: ["Init", "TypeOK"],
      title: "Start with no reference and no authority",
      values: [
        { name: "rowState", value: "free" },
        { name: "authorityState", value: "absent" },
        { name: "referencePresent", value: "FALSE" },
        { name: "rowDeleted", value: "FALSE" },
        { name: "send and replay flags", value: "all TRUE" },
      ],
      what: "The model starts at the row's free label with no durable refund request and no reference. The producer runs the production row and refund machines to supply the labels and edges. The model holds one implicit request and no money amount.",
    },
    {
      code: [
        {
          path: "src/shared/payment/refund-authority.ts",
          symbol: "readyRefund",
        },
      ],
      rules: ["AttachReference", "ClaimRequiresReference"],
      title: "The reference comes before the request or the claim",
      values: [
        { name: "referencePresent", value: "FALSE, then TRUE" },
        { name: "request index", value: "spec-refund-request" },
        { name: "row target", value: "claim" },
        {
          name: "claim result",
          value: "Refused while the reference is FALSE.",
        },
      ],
      what: "The model records reference presence as one Boolean. The action has no absence guard, so a repeat attach changes nothing. Production carries the payment identity in the refund request generation, and readyRefund builds the ready state from that generation. The model records presence only and assumes that the index admits one reference for each payment.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/model.ts",
          symbol: "paymentModel",
        },
      ],
      rules: ["RowStep"],
      title: "A row move refuses a claim without the reference",
      values: [
        { name: "row move", value: "free to claim" },
        { name: "referencePresent", value: "TRUE" },
        { name: "result", value: "Accepted. rowState becomes claim." },
        {
          name: "callback work",
          value: "A row move to review needs no claim.",
        },
      ],
      what: "RowStep chooses one edge from the generated row machine. It refuses entry to any claimed label while the reference is absent. The producer takes the claimed labels from the production row nodes. Callback work needs no held claim, and the model does not require a claim.",
    },
    {
      code: [
        {
          path: "src/shared/payment/refund-authority.ts",
          symbol: "armRefundSend",
        },
        {
          path: "src/shared/payment/refund-authority.ts",
          symbol: "rearmKeyedRefund",
        },
      ],
      rules: [
        "AuthStep",
        "AuthorityRequiresReference",
        "ReplaySafe",
        "OnlyMoneySends",
      ],
      title: "The authority moves only after the reference",
      values: [
        {
          name: "ready to send_armed",
          value: "arm at 1750000000000. The request identity stays the same.",
        },
        {
          name: "keyed replay",
          value: "armedAt 1750000000000 equals replayUntil. inWindow is TRUE.",
        },
        {
          name: "expired keyed replay",
          value:
            "replayUntil 1749999999999. A replay at 1750000000000 is outside the window.",
        },
        {
          name: "keyless replay",
          value: "The request is keyless. A rearm has no permission.",
        },
        {
          name: "observe",
          value: "send_armed to observing. The event moves no money.",
        },
      ],
      what: "AuthStep chooses one generated authority edge and needs the reference. A replay needs a keyed request, the same request identity and a send time inside the finite window. A non-money event cannot replay or enter send_armed. armRefundSend accepts only a ready state. rearmKeyedRefund refuses a keyless request, a different request index and a time past the window.",
    },
    {
      code: [
        {
          path: "src/shared/payment/refund-authority.ts",
          symbol: "markRefundCompleted",
        },
        {
          path: "src/shared/payment/refund-authority.ts",
          symbol: "markRefundLocalRecorded",
        },
      ],
      rules: ["Delete", "Prunable"],
      title: "Deletion keeps unfinished local work",
      values: [
        {
          name: "returned",
          value:
            "Cash returned at 1750000000000. Local records are due. Prunable is FALSE.",
        },
        {
          name: "recorded",
          value: "Local records complete at 1750000000000. Prunable is TRUE.",
        },
        {
          name: "rowDeleted",
          value: "FALSE, then TRUE for the recorded request.",
        },
      ],
      what: "Delete runs once and only at a prunable label. Prunable includes absent authority and completed states with local records complete. markRefundCompleted sets the local record to due. markRefundLocalRecorded completes it. A returned refund with local work due cannot delete the row.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/counterexample.ts",
          symbol: "corruptOneEdge",
        },
      ],
      rules: ["Safety", "Next"],
      title: "The joined safety claim",
      values: [
        { name: "allRequestsPreserved", value: "TRUE on the clean data." },
        {
          name: "corrupted edge",
          value: "requestKept is FALSE on one money edge.",
        },
        { name: "checker", value: "Reports a counterexample." },
      ],
      what: "Safety joins both reference rules, the four verdict flags and the deletion boundary. Next permits reference, row and authority work before deletion, then only a delay. The counterexample changes the request identity of one money edge. The checker must reject that data, or the clean verdicts prove nothing.",
    },
  ],
  title: "Deleting a temporary payment row only after its refund work is done",
};

/** One attendee's provider refund through the first plan and a replay. */
export const refundReversal: ModelGuide = {
  badOutcome:
    "A repeated callback posts a second refund for the same order. Or a refund reverses a group with an operator adjustment or an unpaid balance.",
  cast: [
    {
      meaning:
        "The inverse ledger legs that one returned provider refund proposes.",
      term: "refund plan",
    },
    {
      meaning:
        "One booking and its tax corrections. It is the unit that the refund guards decide on.",
      term: "account refund group",
    },
    {
      meaning:
        "Zero net balance on the attendee account for the group. It is not a provider success status.",
      term: "settled",
    },
    {
      meaning:
        "A group whose legs are only provider cash, with no sale and no operator entry.",
      term: "payment-only",
    },
    {
      meaning:
        "A leg with the same amount as an original and with source and destination swapped.",
      term: "inverse",
    },
    {
      meaning: "The first plan or the plan after the first plan posts.",
      term: "round",
    },
  ],
  claim:
    "This page follows one attendee's provider refund through the first ledger plan and a replay. A plan posts only inverse legs for groups with provider cash, no operator money, and a settled or payment-only account. A replay never reverses a group that the first plan recorded.",
  limits: [
    "The fixtures cover four small ledgers. They do not cover every account, amount or refund path.",
    "The law is per group. Production also has a whole-account path that this model does not prove.",
    "The model checks extracted facts, not money arithmetic itself, provider truth, concurrent plans, SQL atomicity or a crash gap between writes.",
    "The model checks safety. It does not prove that a plan eventually completes.",
  ],
  module: "RefundReversal",
  safety:
    "Every accepted plan keeps the per-group reversal rule, pairs every posted leg with a stored original, and gives every returned reference exactly one outcome. A replay never reverses a recorded group.",
  steps: [
    {
      code: [
        {
          path: "scripts/verify-models/refund-reversal.ts",
          symbol: "refundReversalModelData",
        },
      ],
      rules: ["Init", "TypeOK"],
      title: "Start before the first plan",
      values: [
        { name: "round", value: "first" },
        { name: "recorded", value: "{}" },
        { name: "allPlansSafe", value: "TRUE" },
        { name: "legsSafe", value: "TRUE" },
      ],
      what: "The model starts at the first round with no remembered reversal and no failed verdict. The fixture ledger already exists outside the model. The producer derives every fact from the production plan and ledger functions.",
    },
    {
      code: [
        {
          path: "src/shared/refund-ledger/plan.ts",
          symbol: "refundGroupFacts",
        },
        {
          path: "src/shared/refund-ledger/plan.ts",
          symbol: "computeAttendeeRefunds",
        },
      ],
      rules: ["CanReverse", "SafeReversal"],
      title: "A fully paid group can reverse",
      values: [
        {
          name: "safe group",
          value: "Payment 5000 and sale 5000. Net balance 0. Settled.",
        },
        {
          name: "unsafe group",
          value: "Payment 1000 and sale 3000. 2000 is still owed. Not settled.",
        },
        {
          name: "operator group",
          value:
            "Payment 2000, sale 2000 and adjustment 500. Operator money is present.",
        },
        {
          name: "reversal",
          value: "safe is TRUE. unsafe and operator are FALSE.",
        },
      ],
      what: "CanReverse needs provider cash, no operator money and either payment-only legs or a settled account. refundGroupFacts derives those facts from the attendee account and the group legs. The unsafe group fails the settled test. The operator group fails the operator-money test. A refusal needs no eligibility.",
    },
    {
      code: [
        {
          path: "src/shared/ledger/reverse.ts",
          symbol: "isInverseOf",
        },
      ],
      rules: ["SafeLeg"],
      title: "Each refund leg inverts one stored leg",
      values: [
        {
          name: "safe-sale",
          value: "5000 from the attendee account to revenue account 1.",
        },
        {
          name: "refund leg",
          value:
            "5000 from revenue account 1 to the attendee account. exactInverse is TRUE.",
        },
        {
          name: "unpaired leg",
          value:
            "Reference no-recorded-original is not a stored leg. The producer throws.",
        },
      ],
      what: "SafeLeg needs an exact inverse and a stored original. isInverseOf supplies the comparison of amount and accounts. The producer finds the original in the ledger before it accepts a posted leg. It throws when no stored original pairs, so a bad link never becomes a clean fact.",
    },
    {
      code: [
        {
          path: "src/shared/refund-ledger/plan.ts",
          symbol: "computeAttendeeRefunds",
        },
        {
          path: "scripts/verify-models/refund-reversal.ts",
          symbol: "refundReversalModelData",
        },
      ],
      rules: ["FirstPlan", "PlanRound"],
      title: "The first plan records the safe group",
      values: [
        { name: "round", value: "first, then replay" },
        { name: "recorded", value: "{} then {safe}" },
        { name: "safe legs", value: "2 inverse legs post." },
        { name: "unsafe legs", value: "0 legs post." },
      ],
      what: "FirstPlan applies the per-group rule to every first-round fact. PlanRound keeps any failure and, after the first round, records every reversed group and moves to replay. The safe group posts an inverse of its payment and of its sale. The unsafe group posts nothing and waits for review.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/refund-reversal.ts",
          symbol: "refundReversalModelData",
        },
        {
          path: "src/shared/refund-ledger/plan.ts",
          symbol: "accountRefundGroups",
        },
      ],
      rules: ["ReferencePartition"],
      title: "Every reference has one outcome",
      values: [
        { name: "pi-safe", value: "recorded" },
        { name: "pi-unsafe", value: "review" },
        { name: "pi-missing", value: "unrecorded" },
        {
          name: "coverage",
          value: "One outcome for each round and reference pair.",
        },
      ],
      what: "ReferencePartition requires one outcome for each expected round and reference. accountRefundGroups joins each booking to its tax corrections. The producer marks a reference recorded only when it lies wholly in an eligible group. It marks review when the reference names a group with an unsettled obligation. A reference to a missing booking stays unrecorded.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/refund-reversal.ts",
          symbol: "doubleRecordData",
        },
      ],
      rules: ["ReplayPlan", "Safety", "Next"],
      title: "A replay must not reverse a recorded group",
      values: [
        { name: "round", value: "replay" },
        { name: "recorded", value: "{safe}" },
        {
          name: "safe reversal",
          value: "FALSE in the clean replay plan.",
        },
        {
          name: "control",
          value: "doubleRecordData sets it TRUE. The checker rejects the data.",
        },
      ],
      what: "ReplayPlan checks the grown ledger. SafeReversal refuses any replay fact that claims a reversal of a group in the recorded set. Production posts no second credit because the plan finds the existing refund legs for that group. The control marks the replay plan as reversing safe again. Safety keeps the failed verdict, and Next permits a repeat replay or no change. No rule requires the first plan or a final outcome.",
    },
  ],
  title: "Reversing a returned refund once and never twice",
};
/* jscpd:ignore-end */
