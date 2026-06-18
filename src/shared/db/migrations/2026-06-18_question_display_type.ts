import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-18_question_display_type",
  "Add a required display_type column to custom questions so each question can render as radio buttons or a select box",
  {
    columns: { questions: ["display_type"] },
  },
);
