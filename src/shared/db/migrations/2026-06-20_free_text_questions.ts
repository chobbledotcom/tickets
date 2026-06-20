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
  async ({ getDb }) => {
    await getDb().execute(`UPDATE attendee_answers
      SET question_id = (SELECT question_id FROM answers WHERE answers.id = attendee_answers.answer_id)
      WHERE answer_id IS NOT NULL AND question_id IS NULL`);
  },
);
