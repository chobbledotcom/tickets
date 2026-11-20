import type { ModelGuide } from "#scripts/model-guides/types.ts";

/** A payable Square link must keep its cancel handle. */
/* jscpd:ignore-start -- static data, not code */
export const squareLinkEnd: ModelGuide = {
  badOutcome:
    "A 200 reply with no cancelled order id deletes the only handle, and the Square link stays payable.",
  cast: [
    {
      meaning:
        "One attempt to pay for a reservation. Its payment link opens at Square.",
      term: "checkout",
    },
    {
      meaning:
        "The local row with the data needed to end the link. The stored labels are pending and ending.",
      term: "handle",
    },
    {
      meaning:
        "A background task and the temporary right that it holds on one row.",
      term: "claim",
    },
    {
      meaning: "Square's answer to one delete request.",
      term: "reply",
    },
    {
      meaning:
        "A separate provider message about a payment. It can arrive late.",
      term: "webhook",
    },
    {
      meaning: "A named time interval in the model, not a real timestamp.",
      term: "age",
    },
  ],
  claim:
    "This page follows one unpaid Square checkout from a missing handle to a deleted handle. A success reply without a cancelled order id proves nothing. The site keeps the handle until conclusive evidence or the retention cutoff.",
  limits: [
    "Ages are names for intervals. The model does not read a real clock.",
    "Native lifetime, the retry margin, and provider evidence are assumptions.",
    "The age facts rebuild the cutoffs. They do not execute the prune SQL.",
    "The reply examples cover eight shapes, not every possible message.",
    "SQL races, requests still in flight, and eventual completion need separate tests.",
  ],
  module: "SquareLinkEnd",
  safety:
    "A created link with no end evidence keeps a handle while the native lifetime permits payment. A delete reply moves the row only by its classified event. A cleanup deletion needs age beyond the retention cutoff. A deleted handle never returns.",
  steps: [
    {
      code: [
        {
          path: "src/shared/payment/square-link-end-machine-spec.ts",
          symbol: "LINK_END_NODES",
        },
        {
          path: "src/shared/payment/square-link-end-machine-spec.ts",
          symbol: "SquareLinkEndStateSchema",
        },
      ],
      rules: ["Init", "TypeOK", "CheckoutHistoryConsistent"],
      title: "Start with no handle",
      values: [
        { name: "handleState", value: "unwritten" },
        { name: "sampledAge", value: "zero" },
        { name: "checkoutCreated", value: "FALSE" },
        { name: "linkEndEstablished", value: "FALSE" },
        { name: "handleRemovalSeen", value: "FALSE" },
      ],
      what: "Before checkout creation there is no stored row. The age starts at zero, which is below native expiry. The history flags start TRUE. TypeOK checks these shapes and ties row existence to checkoutCreated.",
    },
    {
      code: [
        {
          path: "src/shared/payment/square-link-end-machine-spec.ts",
          symbol: "squareLinkEndMoveTo",
        },
        {
          path: "src/shared/payment/square-link-end-machine-spec.ts",
          symbol: "LINK_END_MOVES",
        },
        {
          path: "src/shared/payment/square-link-end-machine-spec.ts",
          symbol: "LINK_END_CHECKABLE_NODES",
        },
      ],
      rules: [
        "LocalStep",
        "LocalEvents",
        "CreationDoesNotRecreate",
        "RepresentativeCoverage",
        "AttemptCoverage",
        "EventCoverage",
        "InputFacts",
        "Next",
      ],
      title: "A checkout creates a pending handle",
      values: [
        { name: "checkout_created", value: "unwritten changes to pending" },
        { name: "claim_due", value: "pending changes to ending" },
        { name: "payment_completed", value: "pending changes to gone" },
        {
          name: "second creation",
          value: "A gone row refuses checkout_created.",
        },
      ],
      what: "Checkout creation writes the initial handle. A due task claims it and takes a lease, so the row shows ending. A payment completion can remove a pending handle, but no later creation can recreate a deleted one. Coverage rules require a representative and an attempt for each prepared pair.",
    },
    {
      code: [
        {
          detail: "declaration",
          path: "src/shared/square/link-end.ts",
          symbol: "squareLinkEndEventOf",
        },
        {
          path: "src/shared/square/link-end.ts",
          symbol: "endSquareLink",
        },
      ],
      rules: [
        "ReplyStep",
        "ApplyAttempt",
        "ReplyAgrees",
        "SafeAttempt",
        "ConclusiveEvidence",
        "RetryEvents",
        "RetryReturnsToQueue",
      ],
      title: "Square's answer picks the event",
      values: [
        {
          name: "200 with cancelled_order_id",
          value: "delete_answered_cancelled. ending changes to gone.",
        },
        {
          name: "200 with id only",
          value: "delete_inconclusive. ending changes to pending.",
        },
        {
          name: "409 with PAID",
          value: "delete_refused_paid. ending changes to gone.",
        },
        {
          name: "404",
          value: "delete_answered_missing. ending changes to gone.",
        },
      ],
      what: "The classifier maps the HTTP result to one event. A reply that proves nothing returns the row to pending. A paid refusal also ends the row because completion belongs to the payment path. ReplyStep applies the attempt and records whether the classifier agrees with the independently labelled reply.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/square.ts",
          symbol: "squareModelData",
        },
        {
          path: "src/shared/payment/square-link-end-machine-spec.ts",
          symbol: "LINK_END_NODES",
        },
      ],
      rules: [
        "Age",
        "AgeMatches",
        "MayPay",
        "Prunable",
        "RequiredMargin",
        "AgeStartIsFresh",
        "AgeSamplesCoverStates",
        "TimePreservesPassedBoundaries",
        "AgeData",
      ],
      title: "Time crosses two limits",
      values: [
        { name: "native lifetime", value: "180 days" },
        { name: "retention and margin", value: "183 days" },
        {
          name: "native_before",
          value: "180 days minus 1 ms. mayPay TRUE.",
        },
        { name: "native_at", value: "180 days. mayPay FALSE." },
        { name: "retention_at", value: "183 days. Not prunable." },
        {
          name: "retention_after",
          value: "183 days plus 1 ms. Prunable and margin elapsed.",
        },
      ],
      what: "The producer places samples just before, at, and after each cutoff. Native expiry stops possible payment. The retention cutoff permits cleanup. The model requires the margin to be after native expiry. The supplied age moves never go backwards, and a passed boundary never reverses. Every age name has one fact.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/square.ts",
          symbol: "squareModelData",
        },
        {
          path: "src/shared/payment/square-link-end-machine-spec.ts",
          symbol: "LINK_END_CHECKABLE_NODES",
        },
      ],
      rules: ["Prune", "Prunable", "RequiredMargin"],
      title: "Cleanup needs age past retention",
      values: [
        {
          name: "retention_at",
          value: "183 days exactly. Prunable FALSE. No delete.",
        },
        {
          name: "retention_after",
          value: "183 days plus 1 ms. Prunable TRUE. handleState becomes gone.",
        },
      ],
      what: "Prune deletes a stored handle only when the age is prunable. The rule does not ask for end evidence, because Safety catches an unsafe cutoff by a separate margin check. Cleanup cannot delete at the exact cutoff, since the comparison is strict.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/square.ts",
          symbol: "corruptSquareData",
        },
        {
          path: "src/shared/payment/square-link-end-machine-spec.ts",
          symbol: "LINK_END_MOVES",
        },
      ],
      rules: [
        "Safety",
        "PayableLinkKeepsHandle",
        "CheckoutHistoryConsistent",
        "Next",
      ],
      title: "A payable link keeps a handle",
      values: [
        {
          name: "created, no end evidence, age zero, target gone",
          value: "removalHistorySafe becomes FALSE.",
        },
        {
          name: "created, no end evidence, age zero, target pending",
          value: "allowed",
        },
        {
          name: "retained handle target",
          value: "pending or ending",
        },
      ],
      what: "ApplyAttempt checks the proposed target against the current age. Before native expiry, a created link with no end evidence must land on pending or ending. Safety also requires every retained handle to stay in the checkable set and requires the checkout history to match the row. Next permits a pause, so the model does not force a reply.",
    },
  ],
  title:
    "Keeping a Square cancel handle while a payment link can still take payment",
};
/* jscpd:ignore-end */
