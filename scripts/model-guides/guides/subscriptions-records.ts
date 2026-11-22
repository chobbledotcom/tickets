import type { ModelGuide } from "#scripts/model-guides/types.ts";

/** The story of edits, deletes, merges, and subscriber reads of plans. */
/* jscpd:ignore-start -- static data, not code */
export const subscriptionRecords: ModelGuide = {
  badOutcome:
    "An edit, delete, or merge discards a plan that can still charge, a copied plan loses a column, a refusal leaves a partial write, or the subscriber list drops or invents a row.",
  cast: [
    { meaning: "One person record.", term: "attendee" },
    {
      meaning:
        "One stored link between a person and one listing. It holds a place quantity and possibly a plan.",
      term: "booking row",
    },
    {
      meaning:
        "The provider id, status, period amount, VAT amount, and interval on one booking row.",
      term: "plan",
    },
    {
      meaning:
        "An edit, a delete, or a merge that removes a booking row or its plan.",
      term: "drop",
    },
    {
      meaning: "An operator action that combines two people.",
      term: "merge",
    },
    {
      meaning: "The subscriber list read from the stored booking rows.",
      term: "projection",
    },
    {
      meaning:
        "One result position in the projection. Two equal provider ids do not collapse into one slot.",
      term: "slot",
    },
    {
      meaning:
        "One prepared record from the producer. It is not a live database or Stripe observation.",
      term: "fact",
    },
  ],
  claim:
    "This page follows edits, deletes, and merges of subscription booking rows, and the subscriber list. A live plan survives every drop. A permitted write keeps the exact plan columns, and a refused write changes no row and no money.",
  limits: [
    "The examples use two people, three ticket offers, null dates, and the quantities zero, one, and three.",
    "The model checks one selected order for the delete race, not every race order.",
    "It does not run a live database or a Stripe request. It assumes successful transaction atomicity.",
    "Merge validation and apply are separate observations. Apply alone has no plan-loss guard.",
    "The projection claim covers the subscriber reads. It does not prove page labels, roles, or personal data rules.",
    "The model does not prove that an operation eventually happens.",
  ],
  module: "SubscriptionRecords",
  safety:
    "Every accepted drop leaves any live plan in place. Every kept or moved plan keeps its provider id, amount, tax, interval, and status. A refused write leaves every record and ledger leg unchanged. The subscriber list equals the prepared expected list.",
  steps: [
    {
      code: [
        {
          path: "scripts/verify-models/subscriptions/records-operations.ts",
          symbol: "recordScenarios",
        },
        {
          path: "scripts/verify-models/subscriptions/records-facts.ts",
          symbol: "RECORD_TABLES",
        },
      ],
      rules: ["Init", "Statuses", "Operations", "MergeOperations", "Drops"],
      title: "Start with the prepared record domain",
      values: [
        {
          name: "Statuses",
          value:
            "active, canceled, incomplete, incomplete_expired, past_due, paused, trialing, unpaid, and the empty word for an ordinary row.",
        },
        {
          name: "Operations",
          value:
            "edit-drop, edit-preserve, delete, merge-drop-source, merge-drop-target, merge-move, merge-take-source, merge-preserve-target.",
        },
        {
          name: "MergeOperations",
          value:
            "The five merge words above plus the deliberate late word merge-fault.",
        },
        {
          name: "Drops",
          value:
            "edit-drop, delete, delete-race, merge-drop-source, merge-drop-target.",
        },
        { name: "safe", value: "TRUE when both coverage rules pass." },
      ],
      what: "The model starts with one Boolean. Init sets it from the two coverage rules, so a missing fact makes the first state unsafe. Statuses names eight Stripe words and one empty word for an ordinary row. Operations names eight normal operations. MergeOperations adds a deliberate late merge fault. Drops names the five operations that remove a row or a plan. The empty status word keeps the ordinary row in the same operation table.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/subscriptions/records.ts",
          symbol: "collectRecordFacts",
        },
        {
          path: "scripts/verify-models/subscriptions/records-operations.ts",
          symbol: "recordScenarios",
        },
      ],
      rules: ["OperationCoverage"],
      title: "Every status, place count, and operation occurs",
      values: [
        {
          name: "combinations",
          value: "9 status words times 3 place counts times 8 operations.",
        },
        { name: "base facts", value: "216" },
        {
          name: "extra facts",
          value: "delete-race:active:0 and merge-fault:active:1.",
        },
        { name: "OperationFactsCount", value: "218" },
        { name: "attempt", value: "1 for every fact." },
      ],
      what: "The operation coverage rule requires 218 facts. Eight statuses plus the empty word give nine status words. Three place counts and eight operations give 216 combinations. A stale delete preview and a late merge fault add two more facts. Each combination must appear with attempt one. One combination cannot stand in for another. The producer makes each scenario name from its operation, status, and quantity.",
    },
    {
      code: [
        {
          path: "src/shared/db/attendees/atomic-update.ts",
          symbol: "applyAttendeeAtomicEdit",
        },
        {
          path: "src/shared/db/attendees/delete.ts",
          symbol: "deleteAttendee",
        },
        {
          path: "src/shared/db/subscriptions.ts",
          symbol: "liveListingRefusal",
        },
        {
          path: "src/shared/db/payment-admit-move.ts",
          symbol: "PaymentRowsBusyError",
        },
      ],
      rules: ["Permitted", "OperationLaw"],
      title: "A drop must refuse a live plan",
      values: [
        {
          name: "edit-drop:active:0",
          value:
            "Live TRUE, accepted FALSE, present TRUE, row count 3, plan still sub_protected.",
        },
        {
          name: "edit-drop:canceled:0",
          value: "Live FALSE, accepted TRUE, present FALSE, row count 2.",
        },
        {
          name: "delete:active:0",
          value:
            "Accepted FALSE with PaymentRowsBusyError. Money unchanged TRUE.",
        },
        {
          name: "delete:incomplete_expired:0",
          value: "Accepted TRUE, row count 1.",
        },
        {
          name: "delete-race:active:0",
          value:
            "A stale preview says available. The row turns active again before the writer reads. Delete refused, records unchanged TRUE.",
        },
        {
          name: "edit-preserve:active:0",
          value:
            "Accepted TRUE. Quantity becomes 1. Row count stays 3, and the plan stays exact.",
        },
      ],
      what: "The permitted rule reads one operation and one status. A drop is an edit, a delete, or a merge drop. A live status makes that drop refused. A canceled or incomplete_expired status makes it permitted. An ordinary row is also permitted. The operation law checks the observed decision, the live read, the listing refusal, the row count, and the exact plan columns. A refused write must leave every record and every money row unchanged. The delete check reads the live subscription inside the writer transaction.",
    },
    {
      code: [
        {
          path: "src/shared/merge/attendee-merge.ts",
          symbol: "validateAttendeeMergeDecision",
        },
        {
          path: "src/shared/merge/attendee-merge.ts",
          symbol: "applyAttendeeMerge",
        },
        {
          path: "src/shared/merge/subscription-rows.ts",
          symbol: "droppedSubscriptionErrors",
        },
        {
          path: "src/shared/merge/booking-copy.ts",
          symbol: "copiedBookingColumns",
        },
      ],
      rules: ["ExpectedShape", "PreservedPlan", "Permitted", "OperationLaw"],
      title: "A merge keeps the whole plan or changes nothing",
      values: [
        {
          name: "seed plan",
          value:
            "Provider sub_protected, amount 731, VAT 113, interval month, listing 11.",
        },
        {
          name: "merge-move:active:0",
          value:
            "Attendee 2, present TRUE, new booking id above 0, quantity 0. The plan stays 731, 113, month, active.",
        },
        {
          name: "merge-preserve-target:active:1",
          value: "Attendee 2, booking 1, quantity 1, plan exact.",
        },
        {
          name: "merge-drop-source:active:1",
          value:
            "Accepted FALSE. Validation names listing 11 and the live subscription. Row count 4.",
        },
        {
          name: "merge-fault:active:1",
          value:
            "Apply ran TRUE, accepted FALSE, records unchanged TRUE, money unchanged TRUE.",
        },
      ],
      what: "The expected shape rule states every column for each operation. A kept row keeps listing 11 and its person. A real merge copy gets a new database id, which the model writes as zero. The preserved plan rule compares all five plan columns and the row identity. Validation refuses a merge that drops a live plan. Apply alone has no such guard, so the model also runs a late fault after the row copies and the person write. That fault must roll every write back. A permitted merge can repoint a money leg, but each original amount stays exact.",
    },
    {
      code: [
        {
          path: "src/shared/db/subscriptions.ts",
          symbol: "getSubscribedRows",
        },
        {
          path: "src/shared/db/subscriptions.ts",
          symbol: "getSubscribedRowOrNull",
        },
        {
          path: "scripts/verify-models/subscriptions/records-projection.ts",
          symbol: "projectionFacts",
        },
      ],
      rules: ["ProjectionCoverage", "ProjectionLaw"],
      title: "The subscriber list matches its prepared rows",
      values: [
        {
          name: "expected rows",
          value: "24 rows from 8 status words and 3 place counts.",
        },
        {
          name: "shared provider id",
          value: "sub_shared appears on 2 rows.",
        },
        {
          name: "ordinary rows",
          value:
            "Booking rows 101 and 102 hold no plan. The single read returns null for both.",
        },
        {
          name: "invalid plans",
          value:
            "missing-interval, invalid-interval, missing-status, invalid-status.",
        },
        {
          name: "slots",
          value: "Each result keeps its own position.",
        },
      ],
      what: "The projection coverage rule checks a prepared list of 24 plans before any read. Every live and ended status occurs with zero, one, and three places. Two rows share the provider id sub_shared, so the list must keep both. The projection law compares the full subscriber list with that prepared list. It also requires a loud refusal for four bad plans. Each bad plan fails both the list read and the single-row read. A valid plan read must match the stored plan columns.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/subscriptions/records.ts",
          symbol: "collectRecordFacts",
        },
      ],
      rules: ["OperationStep", "ProjectionStep", "Next", "Safety"],
      title: "One bad fact stays visible",
      values: [
        { name: "good fact", value: "safe TRUE, then TRUE." },
        {
          name: "lost live plan",
          value: "A fact shows a drop of a live plan. safe becomes FALSE.",
        },
        {
          name: "later good projection",
          value: "safe stays FALSE.",
        },
        { name: "no change", value: "The state keeps safe." },
      ],
      what: "Each step selects one prepared fact and checks its law. The operation step reads one operation fact. The projection step reads the projection law. A check that passes keeps safe TRUE. A check that fails sets safe FALSE, and a later check cannot clear it. Next also permits a step with no change, so the model does not require an event. Safety requires safe TRUE.",
    },
  ],
  title: "Subscription plans through edits, deletes, merges, and reads",
};
/* jscpd:ignore-end */
