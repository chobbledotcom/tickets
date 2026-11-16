/**
 * The logistics-agent record: its table and its one write rule. The agents
 * list is the settings page at /admin/logistics.
 */

import { clearLogisticsAgentReferences } from "#db/logistics.ts";
import {
  type LogisticsAgentInput,
  logisticsAgents,
} from "#db/logistics-agents.ts";
import { deleteRow } from "#db/record-table.ts";
import { tables } from "#db/select/tables.ts";
import { agentUsers } from "#db/user-agents.ts";
import { defineNamedRowRecord } from "#shared/rest/named-record.ts";
import type { RecordShapeOf } from "#shared/rest/record.ts";
import type { LogisticsAgent } from "#types";

export const logisticsAgentRecord = defineNamedRowRecord<
  RecordShapeOf<LogisticsAgent, LogisticsAgentInput>
>()({
  activityName: "Logistics agent",
  getAll: logisticsAgents.getAll,
  nameLabel: "logistics.name_label",
  onDelete: async (id) => {
    await clearLogisticsAgentReferences(id);
    await agentUsers.clear(id);
    await deleteRow(tables.logistics_agents, id);
  },
  surface: "settingsLogistics",
  table: tables.logistics_agents,
});
