/**
 * Links between agent users and the logistics agents (vans/crews) they drive.
 *
 * Many-to-many via `user_logistics_agents`: one agent user may cover several
 * logistics agents, and one logistics agent may be driven by several users.
 * The set of agents assigned to a user decides which bookings appear on that
 * user's delivery run sheet (`/admin/deliveries`).
 */

import { linkTableSide } from "#shared/db/link-table.ts";

/** The logistics agents assigned to a user, keyed by user id: read with
 * `getIds` (ascending), replace with `setIds` (deduped). */
export const userAgents = linkTableSide(
  "user_logistics_agents",
  "user_id",
  "agent_id",
);

/** The users assigned to drive a logistics agent, keyed by agent id — the
 * reverse side. `clear` removes every user link to an agent (used before
 * deleting it). */
export const agentUsers = linkTableSide(
  "user_logistics_agents",
  "agent_id",
  "user_id",
);
