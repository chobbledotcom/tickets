/**
 * Links between agent users and the logistics agents (vans/crews) they drive.
 *
 * Many-to-many via `user_logistics_agents`: one agent user may cover several
 * logistics agents, and one logistics agent may be driven by several users.
 * The set of agents assigned to a user decides which bookings appear on that
 * user's delivery run sheet (`/admin/deliveries`).
 */

import { unique } from "#fp";
import { execute, executeBatch, queryAll } from "#shared/db/client.ts";

/** The logistics agent ids assigned to a user, ascending. */
export const getUserAgentIds = async (userId: number): Promise<number[]> => {
  const rows = await queryAll<{ agent_id: number }>(
    "SELECT agent_id FROM user_logistics_agents WHERE user_id = ? ORDER BY agent_id ASC",
    [userId],
  );
  return rows.map((row) => row.agent_id);
};

/**
 * Replace one side of the user↔agent links as a single batch (so a row is
 * never left with a partial set): delete every link for `keyColumn = keyId`,
 * then insert one row per id in `values` (deduped).
 */
const replaceLinks = async (
  keyColumn: "user_id" | "agent_id",
  keyId: number,
  values: number[],
): Promise<void> => {
  const ids = unique(values);
  await executeBatch([
    {
      args: [keyId],
      sql: `DELETE FROM user_logistics_agents WHERE ${keyColumn} = ?`,
    },
    ...ids.map((otherId) => ({
      args: keyColumn === "user_id" ? [keyId, otherId] : [otherId, keyId],
      sql: "INSERT INTO user_logistics_agents (user_id, agent_id) VALUES (?, ?)",
    })),
  ]);
};

/**
 * Replace a user's logistics-agent links with exactly `agentIds` (deduped).
 */
export const setUserAgentIds = (
  userId: number,
  agentIds: number[],
): Promise<void> => replaceLinks("user_id", userId, agentIds);

/** The ids of the users assigned to drive a logistics agent, ascending. */
export const getAgentUserIds = async (agentId: number): Promise<number[]> => {
  const rows = await queryAll<{ user_id: number }>(
    "SELECT user_id FROM user_logistics_agents WHERE agent_id = ? ORDER BY user_id ASC",
    [agentId],
  );
  return rows.map((row) => row.user_id);
};

/**
 * Replace a logistics agent's user links with exactly `userIds` (deduped).
 */
export const setAgentUserIds = (
  agentId: number,
  userIds: number[],
): Promise<void> => replaceLinks("agent_id", agentId, userIds);

/** Remove every user link to a logistics agent (used before deleting it). */
export const clearUserAgentLinksForAgent = async (
  agentId: number,
): Promise<void> => {
  await execute("DELETE FROM user_logistics_agents WHERE agent_id = ?", [
    agentId,
  ]);
};
