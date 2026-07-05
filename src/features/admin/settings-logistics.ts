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
import { OWNER_FORM, requireOwnerOr, withAuth } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
/* jscpd:ignore-start */
import type { IdRouteHandler } from "#routes/entity.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { logActivity } from "#shared/db/activityLog.ts";
/* jscpd:ignore-end */
import { invalidateListingsCache } from "#shared/db/listings.ts";
import { clearLogisticsAgentReferences } from "#shared/db/logistics.ts";
import {
  getAllLogisticsAgents,
  type LogisticsAgentInput,
  logisticsAgentsTable,
} from "#shared/db/logistics-agents.ts";
import { settings } from "#shared/db/settings.ts";
import {
  clearUserAgentLinksForAgent,
  getAgentUserIds,
  setAgentUserIds,
} from "#shared/db/user-agents.ts";
import {
  decryptAdminLevel,
  decryptUsername,
  getUserDisplayFields,
} from "#shared/db/users.ts";
import type { FormParams } from "#shared/form-data.ts";
import { defineNamedResource } from "#shared/rest/resource.ts";
import { isDeliveryRole } from "#shared/types.ts";
import {
  type AgentUserOption,
  adminLogisticsAgentDeletePage,
  adminLogisticsAgentEditPage,
  adminLogisticsAgentNewPage,
  adminLogisticsPage,
} from "#templates/admin/logistics.tsx";
import { logisticsAgentFields } from "#templates/fields.ts";

/**
 * Disabling logistics also clears any saved logistics default, so a later
 * re-enable can't resurrect it onto Use-defaults listings — and listings created
 * while logistics is off are never opted into an inert logistics default.
 */
const clearLogisticsDefaultWhenDisabled = async (
  enabled: boolean,
): Promise<void> => {
  if (enabled) return;
  const defaults = settings.listingDefaults;
  if (defaults.usesLogistics === undefined) return;
  const next = { ...defaults };
  delete next.usesLogistics;
  await settings.update.listingDefaults(next);
  invalidateListingsCache();
};

/** Handle POST /admin/logistics/has-logistics — owner only. */
export const handleHasLogisticsPost = settingsToggle({
  field: "has_logistics",
  label: "Logistics",
  redirectTo: "/admin/logistics",
  save: async (v) => {
    await settings.update.hasLogistics(v);
    await clearLogisticsDefaultWhenDisabled(v);
  },
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
  renderList: adminLogisticsPage,
  renderNew: adminLogisticsAgentNewPage,
  resource: logisticsAgentsResource,
  singular: "Logistics agent",
});

/** The users that may drive a logistics agent, decrypted, as assignable options.
 * Only delivery-eligible roles (owner/manager/agent) are offered — agents see
 * the deliveries page as their only page, owners/managers reach it from the
 * Calendar menu. Editors are excluded: they 403 on the run sheet and can't mark
 * deliveries, so offering them would create an unusable assignment. */
const loadAgentUserOptions = async (): Promise<AgentUserOption[]> => {
  const users = await getUserDisplayFields();
  const options = await Promise.all(
    users.map(async (user) => ({
      adminLevel: await decryptAdminLevel(user),
      id: user.id,
      username: await decryptUsername(user),
    })),
  );
  return options.filter((option) => isDeliveryRole(option.adminLevel));
};

/** The chosen `user_ids` reduced to ids that are real delivery-eligible users,
 * so a crafted form can't link an editor (or unknown id) as a driver. */
const parseAssignedUserIds = async (form: FormParams): Promise<number[]> => {
  const valid = new Set((await loadAgentUserOptions()).map((o) => o.id));
  return form.getNumberArray("user_ids").filter((id) => valid.has(id));
};

/** GET /admin/logistics/:id/edit — agent details plus its assigned users. */
const handleAgentEditGet: IdRouteHandler = (request, { id }) =>
  requireOwnerOr(request, async (session) => {
    applyFlash(request);
    const agent = await logisticsAgentsTable.findById(id);
    if (!agent) return notFoundResponse();
    const [users, selectedIds] = await Promise.all([
      loadAgentUserOptions(),
      getAgentUserIds(id),
    ]);
    return htmlResponse(
      adminLogisticsAgentEditPage(agent, users, new Set(selectedIds), session),
    );
  });

/** POST /admin/logistics/:id/edit — save the agent name and its user links. */
const handleAgentEditPost: IdRouteHandler = (request, { id }) =>
  withAuth(request, OWNER_FORM, async (_session, form) => {
    const result = await logisticsAgentsResource.update(id, form);
    if (!result.ok) {
      if ("notFound" in result) return notFoundResponse();
      return errorRedirect(`/admin/logistics/${id}/edit`, result.error);
    }
    await setAgentUserIds(id, await parseAssignedUserIds(form));
    await logActivity(`Logistics agent '${result.row.name}' updated`);
    return redirect("/admin/logistics", "Logistics agent updated", true);
  });

/** Logistics settings + agent routes. The edit routes override the generic
 * CRUD ones to also manage which users drive the agent. */
export const logisticsRoutes = defineRoutes({
  ...crud.routes,
  "GET /admin/logistics/:id/edit": handleAgentEditGet,
  "POST /admin/logistics/:id/edit": handleAgentEditPost,
  "POST /admin/logistics/has-logistics": handleHasLogisticsPost,
});
