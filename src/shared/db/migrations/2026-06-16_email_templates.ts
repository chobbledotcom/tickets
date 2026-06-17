import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-16_email_templates",
  "Add email_templates table for owner-keypair-encrypted reusable email subjects and bodies",
  {
    newTables: ["email_templates"],
  },
);
