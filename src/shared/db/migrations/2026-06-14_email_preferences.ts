import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-14_email_preferences",
  "Add the per-contact preferences/contact-history table (originally email_preferences, now contact_preferences)",
  {
    newTables: ["contact_preferences"],
  },
);
