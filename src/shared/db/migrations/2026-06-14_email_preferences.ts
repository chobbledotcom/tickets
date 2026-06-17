import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-14_email_preferences",
  "Add email_preferences table for marketing opt-outs and contact history",
  {
    newTables: ["email_preferences"],
  },
);
