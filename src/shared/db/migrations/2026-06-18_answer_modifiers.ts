import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-18_answer_modifiers",
  "Link each question answer to the price modifier it triggers via a modifier_id column on answers (with an 'answer' modifier trigger); drop the per-answer pricing columns (calc_kind/calc_value/direction and the answer aggregate totals) and their attendee_answers triggers in favour of the shared modifier engine",
  {
    columns: { answers: ["modifier_id"] },
    indexes: ["idx_answers_modifier_id"],
  },
  async ({ getDb, recreateTable, syncTriggers }) => {
    // Rebuild attendee_answers and answers from the trimmed SCHEMA. Recreating
    // attendee_answers first drops its three answer-aggregate triggers (a
    // table's triggers go when the table does), so the subsequent answers
    // rebuild can safely drop the total_uses/usage_count/total_revenue columns
    // those triggers wrote to; answers also sheds the calc_kind/calc_value/
    // direction columns while keeping the new modifier_id. Idempotent: on a
    // database that never ran the earlier answer-pricing migration this just
    // reshapes the tables to their current definition.
    await recreateTable("attendee_answers");
    // recreateTable re-installs the *current* attendee_answers triggers, which
    // now include the times_selected aggregate triggers that reference the
    // answers table. Drop them before rebuilding answers so the rebuild can't
    // trip over a trigger pointing at a table mid-recreation, then let
    // syncTriggers reinstall every declared trigger against the new answers.
    for (const name of [
      "trg_attendee_answers_aggregates_insert",
      "trg_attendee_answers_aggregates_delete",
      "trg_attendee_answers_aggregates_update",
    ]) {
      await getDb().execute(`DROP TRIGGER IF EXISTS ${name}`);
    }
    await recreateTable("answers");
    await syncTriggers();
  },
);
