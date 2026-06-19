import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-19_answer_aggregates",
  "Add a times_selected aggregate column to answers, maintained by triggers on attendee_answers, so the question and answer admin pages report selection counts without scanning attendee_answers; backfill from existing data",
  {
    columns: {
      answers: ["times_selected"],
    },
    triggers: [
      "trg_attendee_answers_aggregates_insert",
      "trg_attendee_answers_aggregates_delete",
      "trg_attendee_answers_aggregates_update",
    ],
  },
  ({ backfillAnswerAggregates }) => backfillAnswerAggregates(),
);
