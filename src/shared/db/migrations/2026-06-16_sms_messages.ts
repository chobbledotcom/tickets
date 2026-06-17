import type {
  Migration,
  MigrationContext,
  SchemaRequirement,
} from "./types.ts";

const requires: SchemaRequirement = {
  indexes: ["idx_sms_messages_provider_id", "idx_sms_messages_created"],
  newTables: ["sms_messages"],
};

export default function smsMessagesMigration({
  additive,
  applySchemaChanges,
  syncIndexes,
}: MigrationContext): Migration {
  return additive({
    description:
      "Add sms_messages table mapping gateway message ids to attendees for status webhooks (PII-free; content lives in the activity log)",
    id: "2026-06-16_sms_messages",
    requires,
    up: async () => {
      await applySchemaChanges();
      await syncIndexes();
    },
  });
}
