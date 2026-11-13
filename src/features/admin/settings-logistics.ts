import { t } from "#i18n";
import { defineAdminRoutes, recordRoutes } from "#routes/admin/route-tables.ts";
import { entityFormById, type IdRouteHandler } from "#routes/entity.ts";
/**
 * Admin logistics settings + logistics-agent management — owner only.
 *
 * The logistics page (`/admin/logistics`) carries the agent list. The agent
 * record owns the writes and the deletion references. The edit POST restates
 * the standard key because it also assigns the agent's users.
 */

import { logActivity } from "#db/activity-log.ts";
import { writeRowInTransaction } from "#db/client.ts";
import {
  type LogisticsAgentInput,
  logisticsAgents,
} from "#db/logistics-agents.ts";
import { agentUsers } from "#db/user-agents.ts";
import { adminRedirect, notFoundResponse } from "#routes/response.ts";
import { adminPattern } from "#shared/admin-surface.ts";
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

const pages = recordPages(logisticsAgentRecord, {
  form: logisticsAgentForm,
  identifierLabel: t("logistics.name_label"),
  renderDelete: logisticsAgentPages.deletePage,
  renderList: adminLogisticsPage,
  renderNew: logisticsAgentPages.newPage,
  singular: "Logistics agent",
  toInput: extractLogisticsAgentInput,
});

/** The chosen `user_ids` reduced to ids that are real delivery-eligible users,
 * so a crafted form cannot link an editor (or unknown id) as a driver. */
const parseAssignedUserIds = async (form: FormParams): Promise<number[]> =>
  selectedIdsFromForm(form, "user_ids", await loadAgentUserOptions());

/** Save the agent and assigned users in one transaction. This stays separate
 * from create so crafted create forms cannot assign users. */
const handleAgentEditPost: IdRouteHandler = entityFormById(
  "/admin/logistics/:id/edit",
  async (id, session, form) => {
    const validation = logisticsAgentForm.validate(form);
    if (!validation.valid) {
      return logisticsAgentPage.renderEditError(
        id,
        session,
        form,
        validation.error,
      );
    }
    const existing = await logisticsAgents.table.read.one({ id });
    if (existing === null) return notFoundResponse();
    const userIds = await parseAssignedUserIds(form);
    await writeRowInTransaction(
      await logisticsAgents.table.updateStatement!(id, {
        name: validation.values.name,
      }),
      id,
      (tx) => agentUsers.setIdsTx(tx, id, userIds),
    );
    await logActivity(`Logistics agent '${validation.values.name}' updated`);
    return adminRedirect("logistics", {}, t("logistics.agent_updated"), true);
  },
);

/** Logistics settings + agent routes. The agent edit POST restates the
 * standard key with its own handler. */
export const adminHandlers = defineAdminRoutes({
  ...recordRoutes(
    adminPattern("logistics"),
    adminPattern("logisticsAgent"),
    pages,
    logisticsAgentPage,
  ),
  "POST /admin/logistics/:id/edit": handleAgentEditPost,
});
