import type {
  Migration,
  MigrationContext,
  SchemaRequirement,
} from "./types.ts";

const requires: SchemaRequirement = {
  columns: {
    listing_attendees: ["start_done", "end_done"],
  },
  indexes: [
    "idx_user_logistics_agents_unique",
    "idx_user_logistics_agents_agent_id",
  ],
  newTables: ["user_logistics_agents"],
};

export default function agentUsersMigration({
  additive,
  applySchemaChanges,
  syncIndexes,
}: MigrationContext): Migration {
  return additive({
    description:
      "Add user_logistics_agents table (agent users <-> logistics agents) and start_done/end_done flags on listing_attendees for the delivery-agent run sheet",
    id: "2026-06-16_agent_users",
    requires,
    up: async () => {
      await applySchemaChanges();
      await syncIndexes();
    },
  });
}
