import type { ModelGuide } from "#scripts/model-guides/types.ts";

/** The everyday story of an edit to one attendee's ticket. */
/* jscpd:ignore-start -- static data, not code */
export const attendeeCapacity: ModelGuide = {
  badOutcome:
    "A failed edit leaves one new line behind, or a listing accepts more places than its limit allows.",
  cast: [
    {
      meaning: "One item that a visitor can book, such as a workshop.",
      term: "listing",
    },
    {
      meaning:
        "One stored row that links an attendee to a listing and states a number of places.",
      term: "line",
    },
    {
      meaning:
        "One example listing whose occupied places share a limit. The examples use two dateless slots. Slot one has a limit of three. Slot two has a limit of two.",
      term: "slot",
    },
    {
      meaning:
        "All the database writes for one edit, sent together. The database commits all of them or none.",
      term: "batch",
    },
    {
      meaning:
        "The prepared result of one example run. The fact is not a live customer record.",
      term: "fact",
    },
  ],
  claim:
    "This page follows one edit to one attendee's ticket. The edit writes all its lines or none. No accepted line puts more places on a listing than its limit.",
  limits: [
    "The examples use two dateless listings with limits of three and two places.",
    "They do not prove every date rule, every shared-group rule, or a concurrent edit.",
    "SQL rollback, triggers, and the full caller path need separate database tests.",
    "The model checks safety. It does not prove that an edit eventually finishes.",
  ],
  module: "AttendeeCapacity",
  safety:
    "Every accepted edit keeps both slot totals within their limits. A refused line does not stick in an accepted batch. Every accepted edit keeps at least one line.",
  steps: [
    {
      code: [
        {
          path: "scripts/verify-models/attendee-capacity-seed.ts",
          symbol: "seededClient",
        },
      ],
      rules: ["Init", "TypeOK"],
      title: "Start with an empty example",
      values: [
        { name: "committed", value: "FALSE" },
        { name: "slot1Total", value: "0" },
        { name: "slot2Total", value: "0" },
        { name: "lineCount", value: "0" },
      ],
      what: "The model starts before any edit. The seed prepares the production schema and two listings. The seed does not stand for a live database.",
    },
    {
      code: [
        {
          path: "src/shared/db/capacity.ts",
          symbol: "capacityConditionFor",
        },
        {
          path: "src/shared/db/attendees/atomic-update.ts",
          symbol: "lineStatementFor",
        },
      ],
      rules: ["NoOverfill"],
      title: "One line must fit its listing",
      values: [
        {
          name: "slot one",
          value:
            "Three places are occupied. The limit is three. One more place does not fit.",
        },
        {
          name: "slot two",
          value:
            "One place is occupied. The limit is two. One more place fits.",
        },
      ],
      what: "The production capacity condition checks the limit before the line write. A line that does not fit becomes a refused line fact. The rule reads the already occupied places, which can belong to other attendees.",
    },
    {
      code: [
        {
          path: "src/shared/db/attendees/atomic-update.ts",
          symbol: "buildAttendeeEditBatch",
        },
      ],
      rules: ["NoPartialCommit"],
      title: "One edit is one batch",
      values: [
        {
          name: "batch",
          value: "Add one place on slot two, then add two places on slot one.",
        },
        {
          name: "result",
          value:
            "The slot one line does not fit. The batch must not keep the slot two line.",
        },
        { name: "committed", value: "FALSE" },
      ],
      what: "The production builder returns one statement for each desired line. The model joins each line fact to its batch by the batch name. In an accepted batch, no desired line is independently refused.",
    },
    {
      code: [
        {
          path: "src/shared/db/attendees/atomic-update.ts",
          symbol: "applyAttendeeAtomicEdit",
        },
      ],
      rules: ["CommittedHoldsLine"],
      title: "An accepted edit keeps a line",
      values: [
        { name: "lineCountAfter", value: "1" },
        { name: "committed", value: "TRUE" },
      ],
      what: "An accepted edit cannot remove the last line. A line with zero places still counts as a line. It does not represent a paid place.",
    },
    {
      code: [
        {
          path: "src/shared/db/attendees/atomic-update.ts",
          symbol: "isUnchangedLine",
        },
      ],
      rules: ["PreserveOnlyCommits"],
      title: "An unchanged line can still commit",
      values: [
        { name: "listing active", value: "FALSE" },
        {
          name: "edit",
          value: "Preserve the same line with the same quantity.",
        },
        { name: "committed", value: "TRUE" },
      ],
      what: "A preserve asks for no extra place. The listing can be inactive. The edit must still commit, because it only keeps what the attendee already holds.",
    },
    {
      code: [
        {
          path: "scripts/verify-models/attendee-capacity.ts",
          symbol: "attendeeCapacityModelData",
        },
      ],
      rules: ["BatchStep", "Next", "Safety"],
      title: "A refused batch changes nothing",
      values: [
        {
          name: "accepted fact",
          value: "The snapshot takes the observed totals and line count.",
        },
        {
          name: "refused fact",
          value: "The snapshot keeps every current value.",
        },
      ],
      what: "The step selects any prepared batch fact. An accepted fact replaces the snapshot with its observed totals. A refused fact leaves the snapshot unchanged. The next-state relation also permits a step that changes nothing, so the model does not require an edit to occur.",
    },
  ],
  title: "Editing one attendee's ticket without overfilling a listing",
};
/* jscpd:ignore-end */
