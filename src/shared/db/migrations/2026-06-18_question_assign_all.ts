import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-18_question_assign_all",
  "Add assign_all to custom questions so a question can apply to every listing without per-listing links",
  {
    columns: { questions: ["assign_all"] },
  },
);
