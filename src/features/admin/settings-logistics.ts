/* jscpd:ignore-start */
import { handlersFor } from "#routes/admin/handlers.ts";
import { ownerFormById } from "#routes/entity.ts";
/* jscpd:ignore-end */
/**
 * Admin logistics settings + logistics-agent management — owner only.
 *
 * The logistics page (`/admin/logistics`) carries a simple CRUD list of
 * logistics agents. Agent CRUD reuses the
 * shared owner-CRUD handlers with the logistics page itself as the list view.
 */

/* jscpd:ignore-start */
import type { InValue } from "@libsql/client";
import {
  createOwnerCrudHandlers,
  operationResponse,
} from "#routes/admin/owner-crud.ts";
import type { IdRouteHandler } from "#routes/entity.ts";
import { redirect } from "#routes/response.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { clearLogisticsAgentReferences } from "#shared/db/logistics.ts";
import {
  type LogisticsAgentInput,
  logisticsAgents,
} from "#shared/db/logistics-agents.ts";
import { agentUsers } from "#shared/db/user-agents.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { FormValues } from "#shared/forms/definition.ts";
import { defineNamedResource } from "#shared/rest/resource.ts";
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

/* jscpd:ignore-end */

/** Extract logistics agent input from validated form values. The `name` field
 * is required, so form validation already rejects blank/whitespace names. */
const extractLogisticsAgentInput = (
  values: FormValues<typeof logisticsAgentForm>,
): LogisticsAgentInput => ({
  name: values.name,
});

/** Logistics agents resource for REST create/update/delete. Deleting an agent
 * first clears any booking references so no attendee points at a missing id. */
const logisticsAgentsResourceConfig = {
  form: logisticsAgentForm,
  nameField: "name",
  onDelete: async (id: InValue): Promise<void> => {
    await clearLogisticsAgentReferences(Number(id));
    await agentUsers.clear(Number(id));
    await logisticsAgents.table.deleteById(id);
  },
  table: logisticsAgents.table,
  toInput: extractLogisticsAgentInput,
} as const;

const logisticsAgentsResource = defineNamedResource(
  logisticsAgentsResourceConfig,
);

/** The chosen `user_ids` reduced to ids that are real delivery-eligible users,
 * so a crafted form can't link an editor (or unknown id) as a driver. */
const parseAssignedUserIds = async (form: FormParams): Promise<number[]> =>
  selectedIdsFromForm(form, "user_ids", await loadAgentUserOptions());

const logisticsAgentEditResource = defineNamedResource({
  ...logisticsAgentsResourceConfig,
  afterWrite: async (tx, id, _input, form): Promise<void> => {
    await agentUsers.setIdsTx(tx, id, await parseAssignedUserIds(form));
  },
});

const crud = createOwnerCrudHandlers({
  getAll: logisticsAgents.getAll,
  getName: (agent) => agent.name,
  listPath: "/admin/logistics",
  operations: logisticsAgentsResource,
  renderDelete: logisticsAgentPages.deletePage,
  renderList: adminLogisticsPage,
  renderNew: logisticsAgentPages.newPage,
  singular: "Logistics agent",
});

/** Save the agent and assigned users in one transaction. This stays separate
 * from create so crafted create forms cannot assign users. */
const handleAgentEditPost: IdRouteHandler = ownerFormById(
  async (id, session, form) => {
    const result = await logisticsAgentEditResource.update(id, form);
    return operationResponse(
      result,
      async ({ row }) => {
        await logActivity(`Logistics agent '${row.name}' updated`);
        return redirect("/admin/logistics", "Logistics agent updated", true);
      },
      (error) => logisticsAgentPage.renderEditError(id, session, form, error),
    );
  },
);

/** Logistics settings + agent routes. */
export const adminHandlers = handlersFor("settingsLogistics")({
  getLogistics: crud.listGet,
  getLogisticsById: (request, { id }) =>
    logisticsAgentPage.renderTab(request, id, ""),
  getLogisticsByIdByTab: (request, { id, tab }) =>
    logisticsAgentPage.renderTab(request, id, tab),
  getLogisticsByIdDelete: crud.deleteGet,
  getLogisticsNew: crud.newGet,
  postLogistics: crud.createPost,
  postLogisticsByIdDelete: crud.deletePost,
  postLogisticsByIdEdit: handleAgentEditPost,
});
