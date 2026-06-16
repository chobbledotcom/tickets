/**
 * Links between agent users and the logistics agents (vans/crews) they drive.
 *
 * Many-to-many via `user_logistics_agents`: one agent user may cover several
 * logistics agents, and one logistics agent may be driven by several users.
 * The set of agents assigned to a user decides which bookings appear on that
 * user's delivery run sheet (`/admin/deliveries`).
 */

import { unique } from "#fp";
import { executeBatch, getDb, queryAll } from "#shared/db/client.ts";

/** The logistics agent ids assigned to a user, ascending. */
export const getUserAgentIds = async (userId: number): Promise<number[]> => {
  const rows = await queryAll<{ agent_id: number }>(
    "SELECT agent_id FROM user_logistics_agents WHERE user_id = ? ORDER BY agent_id ASC",
    [userId],
  );
  return rows.map((row) => row.agent_id);
};

/**
 * Replace a user's logistics-agent links with exactly `agentIds` (deduped).
 * Runs as a single batch so a user is never left with a partial set.
 */
export const setUserAgentIds = async (
  userId: number,
  agentIds: number[],
): Promise<void> => {
  const ids = unique(agentIds);
  await executeBatch([
    {
      args: [userId],
      sql: "DELETE FROM user_logistics_agents WHERE user_id = ?",
    },
    ...ids.map((agentId) => ({
      args: [userId, agentId],
      sql: "INSERT INTO user_logistics_agents (user_id, agent_id) VALUES (?, ?)",
    })),
  ]);
};

/** Remove every user link to a logistics agent (used before deleting it). */
export const clearUserAgentLinksForAgent = async (
  agentId: number,
): Promise<void> => {
  await getDb().execute({
    args: [agentId],
    sql: "DELETE FROM user_logistics_agents WHERE agent_id = ?",
  });
};
