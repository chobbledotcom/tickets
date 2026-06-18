import type { MigrationContext } from "./types.ts";

export default (context: MigrationContext) =>
  context.additive({
    description:
      "Add a required display_type column to custom questions so each question can render as radio buttons or a select box",
    id: "2026-06-18_question_display_type",
    requires: { columns: { questions: ["display_type"] } },
    up: async () => {
      await context.getDb().batch(
        [
          {
            args: [],
            sql: "CREATE TABLE questions_new (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, display_type TEXT NOT NULL)",
          },
          {
            args: [],
            sql: "INSERT INTO questions_new (id, text, sort_order, display_type) SELECT id, text, sort_order, 'radio' FROM questions",
          },
          { args: [], sql: "DROP TABLE questions" },
          { args: [], sql: "ALTER TABLE questions_new RENAME TO questions" },
        ],
        "write",
      );
    },
  });
