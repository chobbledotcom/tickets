import { sql, sqlName } from "#db/sql.ts";
import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-11-20_question_answer_level",
  "Add answer_level to custom questions, and listing_attendee_id to attendee answers. A free-text question can ask once for each booked listing. Every stored answer and question keeps asking once for the booking.",
  {
    columns: {
      attendee_answers: ["listing_attendee_id"],
      questions: ["answer_level"],
    },
    indexes: [
      "idx_attendee_answers_listing_attendee_id",
      "idx_attendee_listing_answers_unique",
      "idx_attendee_string_answers_unique",
    ],
    triggers: ["trg_listing_attendees_answers_delete"],
  },
  // The one-answer-per-question index now covers booking answers only.
  // The index sync never changes an index that keeps its name, so drop the
  // old definition and let the schema create the new one.
  async ({ getDb, syncIndexes }) => {
    await getDb().execute(
      sql`DROP INDEX IF EXISTS ${sqlName("idx_attendee_string_answers_unique")}`,
    );
    await syncIndexes();
  },
);
