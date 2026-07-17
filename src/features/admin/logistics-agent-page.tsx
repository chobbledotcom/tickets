/**
 * The logistics-agent entity page: an owner-only Edit / Actions surface under
 * /admin/logistics/:id. The edit panel loads eligible users and current links
 * only when its tab is opened.
 */

/* jscpd:ignore-start */
import type { EntityPage } from "#routes/admin/entity-pages.ts";
import { defineEditEntityPage } from "#routes/admin/entity-write-tab.ts";
import { requireOwnerOr } from "#routes/auth.ts";
import { logisticsAgents } from "#shared/db/logistics-agents.ts";
import { agentUsers } from "#shared/db/user-agents.ts";
import {
  decryptAdminLevel,
  decryptUsername,
  getUserDisplayFields,
} from "#shared/db/users.ts";
import { isDeliveryRole, type LogisticsAgent } from "#shared/types.ts";
import {
  type AgentUserOption,
  LogisticsAgentEditPanel,
} from "#templates/admin/logistics.tsx";

/* jscpd:ignore-end */

/** Users that may drive a logistics agent, decrypted as assignable options. */
export const loadAgentUserOptions = async (): Promise<AgentUserOption[]> => {
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

/** The tabbed logistics-agent page. */
export const logisticsAgentPage: EntityPage<LogisticsAgent> =
  defineEditEntityPage({
    basePath: (id) => `/admin/logistics/${id}`,
    deleteLabelKey: "logistics.delete_agent",
    edit: async (agent) => {
      const [users, selectedIds] = await Promise.all([
        loadAgentUserOptions(),
        agentUsers.getIds(agent.id),
      ]);
      return LogisticsAgentEditPanel({
        agent,
        selectedUserIds: new Set(selectedIds),
        users,
      });
    },
    editSlug: "",
    guard: requireOwnerOr,
    load: (id) => logisticsAgents.table.findById(id),
    navActive: { section: "/admin/logistics" },
  });
