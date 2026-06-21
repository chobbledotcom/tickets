import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-20_answer_active",
  "Add an active flag to answers so an owner can deactivate a choice (hidden on the public booking form, still shown for attendees who already selected it) instead of deleting it",
  {
    columns: {
      answers: ["active"],
    },
  },
);
