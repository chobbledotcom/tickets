/**
 * Links between agent users and the logistics agents (vans/crews) they drive.
 *
 * Many-to-many via `user_logistics_agents`: one agent user may cover several
 * logistics agents, and one logistics agent may be driven by several users.
 * The set of agents assigned to a user decides which bookings appear on that
 * user's delivery run sheet (`/admin/deliveries`).
 */

import { linkTableSide } from "#shared/db/link-table.ts";

const byUser = linkTableSide("user_logistics_agents", "user_id", "agent_id");
const byAgent = linkTableSide("user_logistics_agents", "agent_id", "user_id");

/** The logistics agent ids assigned to a user, ascending. */
export const getUserAgentIds = byUser.getIds;

/** Replace a user's logistics-agent links with exactly `agentIds` (deduped). */
export const setUserAgentIds = byUser.setIds;

/** The ids of the users assigned to drive a logistics agent, ascending. */
export const getAgentUserIds = byAgent.getIds;

/** Replace a logistics agent's user links with exactly `userIds` (deduped). */
export const setAgentUserIds = byAgent.setIds;

/** Remove every user link to a logistics agent (used before deleting it). */
export const clearUserAgentLinksForAgent = byAgent.clear;
