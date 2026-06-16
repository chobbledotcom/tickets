/**
 * Logistics agents table operations.
 *
 * A logistics agent is a simple named entity (typically a van) used to record
 * who drops off and collects equipment-hire bookings. Names are encrypted at
 * rest, matching the treatment of other owner-entered labels (e.g. holidays).
 */

import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { encryptedNameSchema } from "#shared/db/common-schema.ts";
import { queryAndMap } from "#shared/db/query.ts";
import { cachedTable, col, defineTable } from "#shared/db/table.ts";
import type { LogisticsAgent } from "#shared/types.ts";

/** Logistics agent input fields for create/update (camelCase). */
export type LogisticsAgentInput = {
  name: string;
};

/** Raw logistics_agents table — name is encrypted, id is generated. */
const rawLogisticsAgentsTable = defineTable<
  LogisticsAgent,
  LogisticsAgentInput
>({
  name: "logistics_agents",
  primaryKey: "id",
  schema: {
    id: col.generated<number>(),
    ...encryptedNameSchema(encrypt, decrypt),
  },
});

/** Execute a query and decrypt the resulting logistics agent rows. */
const queryLogisticsAgents = queryAndMap<LogisticsAgent, LogisticsAgent>(
  (row) => rawLogisticsAgentsTable.fromDb(row),
);

const logisticsAgentsCache = cachedTable({
  fetchAll: () =>
    queryLogisticsAgents("SELECT * FROM logistics_agents ORDER BY id ASC"),
  name: "logistics_agents",
  table: rawLogisticsAgentsTable,
});

/** Logistics agents table with CRUD operations — writes auto-invalidate the cache. */
export const logisticsAgentsTable = logisticsAgentsCache.table;

/** Invalidate the logistics agents cache (for testing or after writes). */
export const invalidateLogisticsAgentsCache = (): void => {
  logisticsAgentsCache.invalidate();
};

/** Get all logistics agents, decrypted, ordered by id (from cache). */
export const getAllLogisticsAgents = (): Promise<LogisticsAgent[]> =>
  logisticsAgentsCache.getAll();

/** A lookup from logistics-agent id to name, for run sheets and CSV exports. */
export const agentNameMap = (
  agents: readonly LogisticsAgent[],
): Map<number, string> => new Map(agents.map((a) => [a.id, a.name]));
