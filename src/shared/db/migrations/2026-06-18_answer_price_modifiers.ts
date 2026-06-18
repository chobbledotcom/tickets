import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-18_answer_price_modifiers",
  "Add optional price modifier fields and trigger-maintained usage/revenue aggregates to answers so custom-question answers can modify checkout prices and report cumulative totals",
  {
    columns: {
      answers: [
        "calc_kind",
        "calc_value",
        "direction",
        "total_uses",
        "usage_count",
        "total_revenue",
      ],
      attendee_answers: ["amount_applied"],
    },
    triggers: [
      "trg_attendee_answers_aggregates_insert",
      "trg_attendee_answers_aggregates_delete",
      "trg_attendee_answers_aggregates_update",
    ],
  },
);
