import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-16_sms_messages",
  "Add sms_messages table mapping gateway message ids to attendees for status webhooks (PII-free; content lives in the activity log)",
  {
    indexes: ["idx_sms_messages_provider_id", "idx_sms_messages_created"],
    newTables: ["sms_messages"],
  },
);
