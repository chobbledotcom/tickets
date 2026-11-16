import { encrypt } from "#crypto/encryption.ts";
import type { BlindIndex, WrappedKey } from "#crypto/sealed.ts";
import { getDb, queryAll } from "#db/client.ts";
import { records } from "#db/record-table.ts";
import { tables } from "#db/select/tables.ts";
import { createSession } from "#db/sessions.ts";
import { sql } from "#db/sql.ts";
import { userAgents } from "#db/user-agents.ts";
import { insertInto } from "#db/write.ts";

export const addUserOwnedAccessRecords = async (
  userId: number,
  label: string,
): Promise<void> => {
  const agent = await records.logistics_agents.insert({
    name: `${label} agent`,
  });
  await userAgents.setIds(userId, [agent.id]);
  await createSession(
    `${label}-session`,
    `${label}-csrf`,
    Date.now() + 60_000,
    null,
    userId,
  );
  await getDb().execute(
    insertInto(tables.api_keys, {
      created: "2026-07-19T00:00:00.000Z",
      key_index: `${label}-key-index` as BlindIndex,
      last_used: "",
      name: await encrypt(`${label} key`),
      user_id: userId,
      wrapped_data_key: `${label}-wrapped-key` as WrappedKey,
    }),
  );
};

export const getUserOwnedRowSources = async (
  userId: number,
): Promise<string[]> =>
  (
    await queryAll<{ source: string }>(
      sql`SELECT 'api_keys' AS source FROM api_keys WHERE user_id = ${userId}
       UNION ALL SELECT 'sessions' FROM sessions WHERE user_id = ${userId}
       UNION ALL SELECT 'user_logistics_agents' FROM user_logistics_agents WHERE user_id = ${userId}
       UNION ALL SELECT 'users' FROM users WHERE id = ${userId}`,
    )
  ).map(({ source }) => source);
