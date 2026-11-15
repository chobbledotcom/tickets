/**
 * Admin logistics settings + logistics-agent management — owner only.
 *
 * The logistics page (`/admin/logistics`) carries the agent list. The agent
 * record owns the writes and the deletion references. An edit also assigns
 * the agent's users, in the same transaction as the row.
 */

import type { LogisticsAgentInput } from "#db/logistics-agents.ts";
import { agentUsers } from "#db/user-agents.ts";
import { defineAdminRoutes, recordRoutes } from "#routes/admin/route-tables.ts";
import type { FormParams } from "#shared/form-data.ts";
import { logisticsAgentRecord } from "#shared/records/logistics-agents.ts";
import { recordPages } from "#shared/rest/record-pages.ts";
import { selectedIdsFromForm } from "#shared/selected-ids.ts";
import {
  adminLogisticsPage,
  logisticsAgentPages,
} from "#templates/admin/logistics.tsx";
import { logisticsAgentForm } from "#templates/fields/listing.ts";
import {
  loadAgentUserOptions,
  logisticsAgentPage,
} from "./logistics-agent-page.tsx";

/** Extract logistics agent input from validated form values. The `name` field
 * is required, so form validation already rejects blank/whitespace names. */
const extractLogisticsAgentInput = (values: {
  name: string;
}): LogisticsAgentInput => ({
  name: values.name,
});

/** The chosen `user_ids` reduced to ids that are real delivery-eligible users,
 * so a crafted form cannot link an editor (or unknown id) as a driver. */
const parseAssignedUserIds = async (form: FormParams): Promise<number[]> =>
  selectedIdsFromForm(form, "user_ids", await loadAgentUserOptions());

const pages = recordPages(logisticsAgentRecord, {
  // Only an edit assigns users, so a crafted create form cannot.
  editPlan: async (form) => {
    const userIds = await parseAssignedUserIds(form);
    return { persist: (tx, id) => agentUsers.setIdsTx(tx, id, userIds) };
  },
  form: logisticsAgentForm,
  renderDelete: logisticsAgentPages.deletePage,
  renderEditError: logisticsAgentPage.renderEditError,
  renderList: adminLogisticsPage,
  renderNew: logisticsAgentPages.newPage,
  toInput: extractLogisticsAgentInput,
});

/** Logistics settings + agent routes. */
export const adminHandlers = defineAdminRoutes(
  recordRoutes("settingsLogistics", pages, logisticsAgentPage),
);
