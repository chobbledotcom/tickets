import { encrypt } from "#crypto/encryption.ts";
import { getDb, insert, queryAll } from "#db/client.ts";
import { logisticsAgents } from "#db/logistics-agents.ts";
import { createSession } from "#db/sessions.ts";
import { userAgents } from "#db/user-agents.ts";

export const addUserOwnedAccessRecords = async (
  userId: number,
  label: string,
): Promise<void> => {
  const agent = await logisticsAgents.table.insert({ name: `${label} agent` });
  await userAgents.setIds(userId, [agent.id]);
  await createSession(
    `${label}-session`,
    `${label}-csrf`,
    Date.now() + 60_000,
    null,
    userId,
  );
  await getDb().execute(
    insert("api_keys", {
      created: "2026-07-19T00:00:00.000Z",
      key_index: `${label}-key-index`,
      last_used: "",
      name: await encrypt(`${label} key`),
      user_id: userId,
      wrapped_data_key: `${label}-wrapped-key`,
    }),
  );
};

export const getUserOwnedRowSources = async (
  userId: number,
): Promise<string[]> =>
  (
    await queryAll<{ source: string }>(
      `SELECT 'api_keys' AS source FROM api_keys WHERE user_id = ?
       UNION ALL SELECT 'sessions' FROM sessions WHERE user_id = ?
       UNION ALL SELECT 'user_logistics_agents' FROM user_logistics_agents WHERE user_id = ?
       UNION ALL SELECT 'users' FROM users WHERE id = ?`,
      [userId, userId, userId, userId],
    )
  ).map(({ source }) => source);
