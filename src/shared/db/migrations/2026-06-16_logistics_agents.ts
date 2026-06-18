import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-16_logistics_agents",
  "Add logistics_agents table, uses_logistics flag on listings, split_logistics_agents on attendees, and start_agent_id/end_agent_id/start_time/end_time on listing_attendees for the logistics flow",
  {
    columns: {
      attendees: ["split_logistics_agents"],
      listing_attendees: [
        "start_agent_id",
        "end_agent_id",
        "start_time",
        "end_time",
      ],
      listings: ["uses_logistics"],
    },
    newTables: ["logistics_agents"],
  },
);
