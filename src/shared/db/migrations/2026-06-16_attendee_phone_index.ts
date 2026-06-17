import type {
  Migration,
  MigrationContext,
  SchemaRequirement,
} from "./types.ts";

const requires: SchemaRequirement = {
  columns: { attendees: ["phone_index"] },
  indexes: ["idx_attendees_phone_index"],
};

export default function attendeePhoneIndexMigration({
  additive,
  applySchemaChanges,
  syncIndexes,
}: MigrationContext): Migration {
  return additive({
    description:
      "Add phone_index to attendees so inbound SMS replies can be matched to an attendee",
    id: "2026-06-16_attendee_phone_index",
    requires,
    up: async () => {
      await applySchemaChanges();
      await syncIndexes();
    },
  });
}
