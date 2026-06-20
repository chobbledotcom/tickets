import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-20_free_text_questions",
  "Add free-text custom questions backed by an owner-key encrypted strings repository, with attendee answer references and string usage aggregates",
  {
    columns: {
      attendee_answers: ["question_id", "string_id"],
    },
    indexes: [
      "idx_strings_text_index",
      "idx_attendee_answers_question_id",
      "idx_attendee_answers_string_id",
      "idx_attendee_string_answers_unique",
    ],
    newTables: ["strings"],
    triggers: [
      "trg_attendee_answers_validate_insert",
      "trg_attendee_answers_validate_update",
      "trg_attendee_answers_strings_insert",
      "trg_attendee_answers_strings_delete",
      "trg_attendee_answers_strings_update",
    ],
  },
  async ({ getDb, recreateTable, syncTriggers }) => {
    // Existing databases still carry the pre-feature column constraints that the
    // additive schema sync cannot relax: attendee_answers.answer_id is NOT NULL
    // (free-text rows need it NULL) and questions.display_type's CHECK omits
    // 'free_text'. Rebuild both tables from the current SCHEMA so text rows and
    // free_text questions are accepted. recreateTable copies existing rows,
    // re-creates the table's indexes, and re-installs its triggers; syncTriggers
    // then reconciles the rest. Idempotent: on a fresh database already built
    // from the current schema this reshapes the tables to the same definition.
    //
    // recreateTable drops and re-creates the table, so anything still holding a
    // legacy FK to it must be rebuilt FK-free first or libsql aborts the DROP
    // (PRAGMA foreign_keys=OFF does not persist across Turso HTTP requests).
    // answers was already rebuilt by the answer_modifiers migration; listing_-
    // questions is the last table still referencing questions, so rebuild it
    // before questions.
    await recreateTable("attendee_answers");
    await recreateTable("listing_questions");
    await recreateTable("questions");
    await syncTriggers();
    // Backfill question_id onto pre-existing choice rows (text rows are new and
    // already carry it). Runs after the rebuild so the column exists under the
    // relaxed constraints and the validation trigger sees a valid NEW row.
    await getDb().execute(`UPDATE attendee_answers
      SET question_id = (SELECT question_id FROM answers WHERE answers.id = attendee_answers.answer_id)
      WHERE answer_id IS NOT NULL AND question_id IS NULL`);
  },
);
