import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-18_answer_modifiers",
  "Link question answers to price modifiers via a modifier_answers table and an 'answer' modifier trigger; drop the per-answer pricing columns (calc_kind/calc_value/direction and the answer aggregate totals) and their attendee_answers triggers in favour of the shared modifier engine",
  {
    indexes: ["idx_modifier_answers_pair", "idx_modifier_answers_answer"],
    newTables: ["modifier_answers"],
  },
  async ({ recreateTable }) => {
    // Rebuild attendee_answers and answers from the trimmed SCHEMA. Recreating
    // attendee_answers first drops its three answer-aggregate triggers (a
    // table's triggers go when the table does), so the subsequent answers
    // rebuild can safely drop the total_uses/usage_count/total_revenue columns
    // those triggers wrote to; answers also sheds the calc_kind/calc_value/
    // direction columns. Idempotent: on a database that never ran the earlier
    // answer-pricing migration this just reshapes the tables to their current
    // definition.
    await recreateTable("attendee_answers");
    await recreateTable("answers");
  },
);
