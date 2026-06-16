/**
 * Admin logistics settings + logistics-agent management — owner only.
 *
 * The logistics page (`/admin/logistics`) carries the has-logistics toggle and,
 * when enabled, a simple CRUD list of logistics agents. Agent CRUD reuses the
 * shared owner-CRUD handlers with the logistics page itself as the list view.
 */

import type { InValue } from "@libsql/client";
import { createOwnerCrudHandlers } from "#routes/admin/owner-crud.ts";
import { settingsToggle } from "#routes/admin/settings-helpers.ts";
import { defineRoutes } from "#routes/router.ts";
import { clearLogisticsAgentReferences } from "#shared/db/logistics.ts";
import {
  getAllLogisticsAgents,
  type LogisticsAgentInput,
  logisticsAgentsTable,
} from "#shared/db/logistics-agents.ts";
import { settings } from "#shared/db/settings.ts";
import { clearUserAgentLinksForAgent } from "#shared/db/user-agents.ts";
import { defineNamedResource } from "#shared/rest/resource.ts";
import {
  adminLogisticsAgentDeletePage,
  adminLogisticsAgentEditPage,
  adminLogisticsAgentNewPage,
  adminLogisticsPage,
} from "#templates/admin/logistics.tsx";
import { logisticsAgentFields } from "#templates/fields.ts";

/** Handle POST /admin/logistics/has-logistics — owner only. */
export const handleHasLogisticsPost = settingsToggle({
  field: "has_logistics",
  label: "Logistics",
  redirectTo: "/admin/logistics",
  save: (v) => settings.update.hasLogistics(v),
});

/** Extract logistics agent input from validated form values. The `name` field
 * is required, so form validation already rejects blank/whitespace names. */
const extractLogisticsAgentInput = (
  values: Record<string, string | number | null>,
): LogisticsAgentInput => ({
  name: String(values.name),
});

/** Logistics agents resource for REST create/update/delete. Deleting an agent
 * first clears any booking references so no attendee points at a missing id. */
const logisticsAgentsResource = defineNamedResource({
  fields: logisticsAgentFields,
  nameField: "name",
  onDelete: async (id: InValue): Promise<void> => {
    await clearLogisticsAgentReferences(Number(id));
    await clearUserAgentLinksForAgent(Number(id));
    await logisticsAgentsTable.deleteById(id);
  },
  table: logisticsAgentsTable,
  toInput: extractLogisticsAgentInput,
});

const crud = createOwnerCrudHandlers({
  getAll: getAllLogisticsAgents,
  getName: (a) => a.name,
  listPath: "/admin/logistics",
  renderDelete: adminLogisticsAgentDeletePage,
  renderEdit: adminLogisticsAgentEditPage,
  renderList: adminLogisticsPage,
  renderNew: adminLogisticsAgentNewPage,
  resource: logisticsAgentsResource,
  singular: "Logistics agent",
});

/** Logistics settings + agent routes. */
export const logisticsRoutes = defineRoutes({
  ...crud.routes,
  "POST /admin/logistics/has-logistics": handleHasLogisticsPost,
});
