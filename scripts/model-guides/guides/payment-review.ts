import type { ModelGuide } from "#scripts/model-guides/types.ts";

/** The owner review case must keep its identity until the right evidence. */
/* jscpd:ignore-start -- static data, not code */
export const paymentReview: ModelGuide = {
  badOutcome:
    "An acknowledgement replaces the case with a new id, or partial-return evidence retires a shared-reference case.",
  cast: [
    {
      meaning:
        "The site's record of money for a reservation. Its optional review slot holds one case.",
      term: "payment row",
    },
    {
      meaning: "A recorded disagreement for the owner. It is not a refund.",
      term: "review case",
    },
    {
      meaning:
        "The stated cause. The model uses partially_returned_obligation and shared_reference.",
      term: "reason",
    },
    {
      meaning:
        "No case, an unseen case, or a case that the owner acknowledged.",
      term: "slot state",
    },
    {
      meaning:
        "The value that distinguishes one disagreement from a later one.",
      term: "case id",
    },
    {
      meaning:
        "The fact that retires a reason. It is supplied to the model, not proved.",
      term: "evidence",
    },
  ],
  claim:
    "This page follows one review case on a payment row. A new case opens unseen with its stated reason. An acknowledgement keeps the same case id and reason. Only evidence for that reason retires the case.",
  limits: [
    "The model covers two reasons and one representative for each open and seen state.",
    "The state name omits the concrete case id. The producer compares that id before abstraction.",
    "Retirement evidence arrives as events. The model does not prove the underlying money facts.",
    "No amount or currency appears. Provider transfers are outside this model.",
    "SQL races, eventual review, and the refund path need separate tests.",
  ],
  module: "PaymentReview",
  safety:
    "An accepted acknowledgement keeps the case id and reason. A new case opens only on an empty slot. Retirement needs the matching reason. A refusal keeps the same case id and reason. No review event moves money.",
  steps: [
    {
      code: [
        {
          path: "src/shared/payment/review-machine-spec.ts",
          symbol: "REVIEW_NODES",
        },
        {
          path: "src/shared/payment/review-machine-spec.ts",
          symbol: "reviewNodeOf",
        },
      ],
      rules: ["Init", "TypeOK"],
      title: "Start with no case",
      values: [
        { name: "reviewState", value: "none" },
        { name: "allAttemptsSafe", value: "TRUE" },
        {
          name: "abstract states",
          value: "none, open and seen for two reasons",
        },
      ],
      what: "The review slot starts empty. The model has five abstract names from three node shapes and two reasons. No database row is created for this start state.",
    },
    {
      code: [
        {
          path: "src/shared/payment/review-machine-spec.ts",
          symbol: "REVIEW_EVENTS",
        },
        {
          path: "src/shared/payment/review-machine-spec.ts",
          symbol: "REVIEW_REASONS",
        },
      ],
      rules: [
        "ReviewStep",
        "AcceptedReviewAction",
        "OpensUnseenCase",
        "SafeAttempt",
      ],
      title: "Open a case",
      values: [
        {
          name: "event",
          value: "open_shared_reference",
        },
        {
          name: "reviewState",
          value: "none changes to open(shared_reference)",
        },
        { name: "seen", value: "FALSE" },
        { name: "event movesMoney", value: "FALSE" },
      ],
      what: "A new case opens only on an empty slot. It starts unseen and takes the event reason. SafeAttempt also requires that the event declares no money move. The model selects an attempt that starts at the current state.",
    },
    {
      code: [
        {
          path: "src/shared/payment/review-machine-spec.ts",
          symbol: "REVIEW_NODES",
        },
        {
          path: "src/shared/payment/review-machine-spec.ts",
          symbol: "reviewNodeOf",
        },
      ],
      rules: [
        "AcknowledgesUnseenCase",
        "HeldCaseKeepsIdentity",
        "AcceptedReviewAction",
      ],
      title: "Acknowledge keeps the case",
      values: [
        {
          name: "reviewState",
          value: "open(shared_reference) changes to seen(shared_reference)",
        },
        {
          name: "case id",
          value: "One example id keeps the same value before and after.",
        },
        { name: "acknowledgedAt", value: "2026-08-16T00:00:00.000Z" },
        { name: "reason", value: "shared_reference, unchanged" },
      ],
      what: "The owner acknowledgement changes an unseen case to a seen case. It keeps the same case id and reason and only adds the acknowledged time. HeldCaseKeepsIdentity demands that exact identity. A replacement case id fails the rule.",
    },
    {
      code: [
        {
          path: "src/shared/payment/review-machine-spec.ts",
          symbol: "REVIEW_EVENTS",
        },
      ],
      rules: [
        "RetiresMatchingCase",
        "RefusalKeepsCase",
        "AcceptedReviewAction",
        "HeldCaseKeepsIdentity",
      ],
      title: "Wrong evidence is refused",
      values: [
        {
          name: "stored state",
          value: "seen(partially_returned_obligation)",
        },
        {
          name: "event",
          value: "retire_shared_reference",
        },
        { name: "accepted", value: "FALSE" },
        { name: "reviewState", value: "unchanged" },
        { name: "case id and reason", value: "unchanged" },
      ],
      what: "Retirement requires the stored reason. The producer records a refused attempt with the same state, case id, and reason. A refused attempt does not remove the case. The refusal law also requires the same state before and after.",
    },
    {
      code: [
        {
          path: "src/shared/payment/review-machine-spec.ts",
          symbol: "REVIEW_REASONS",
        },
        {
          path: "src/shared/payment/review-machine-spec.ts",
          symbol: "REVIEW_EVENTS",
        },
      ],
      rules: ["RetiresMatchingCase", "AcceptedReviewAction"],
      title: "Matching evidence retires the case",
      values: [
        {
          name: "stored state",
          value: "seen(shared_reference)",
        },
        {
          name: "event",
          value: "retire_shared_reference",
        },
        { name: "evidence", value: "unique_reference" },
        {
          name: "reviewState",
          value: "seen(shared_reference) changes to none",
        },
      ],
      what: "Matching evidence removes the case. The declared retirement for shared_reference is a unique reference. The declared retirement for partially_returned_obligation is all money returned and recorded. The model receives these facts as events.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/review.ts",
          symbol: "reviewModelData",
        },
        {
          path: "scripts/verify-models/review.ts",
          symbol: "corruptReviewData",
        },
      ],
      rules: ["Safety", "Next", "ReviewStep"],
      title: "Safety joins the review laws",
      values: [
        {
          name: "safe run",
          value: "All attempt checks pass. allAttemptsSafe stays TRUE.",
        },
        {
          name: "changed case id on acknowledge",
          value: "sameCaseId is FALSE. Safety fails.",
        },
        { name: "pause", value: "Both values stay equal." },
      ],
      what: "Safety requires valid state names, a clean attempt history, and every accepted or refused review law. ReviewStep applies any prepared attempt and keeps a false verdict. Next permits a pause, so no owner or system action is forced.",
    },
  ],
  title: "Keeping a payment review case until the right evidence retires it",
};
/* jscpd:ignore-end */
