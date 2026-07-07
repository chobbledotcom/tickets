/**
 * Logistics agents table operations.
 *
 * A logistics agent is a simple named entity (typically a van) used to record
 * who drops off and collects equipment-hire bookings. Names are encrypted at
 * rest, matching the treatment of other owner-entered labels (e.g. holidays).
 */

import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { encryptedNameSchema } from "#shared/db/common-schema.ts";
import { col, defineCachedListTable } from "#shared/db/table.ts";
import type { LogisticsAgent } from "#shared/types.ts";

/** Logistics agent input fields for create/update (camelCase). */
export type LogisticsAgentInput = {
  name: string;
};

/** Cached logistics_agents table — name is encrypted, id is generated; writes
 * auto-invalidate the cache. */
export const logisticsAgents = defineCachedListTable<
  LogisticsAgent,
  LogisticsAgentInput
>({
  name: "logistics_agents",
  orderBy: "id ASC",
  primaryKey: "id",
  schema: {
    id: col.generated<number>(),
    ...encryptedNameSchema(encrypt, decrypt),
  },
});

/** A lookup from logistics-agent id to name, for run sheets and CSV exports. */
export const agentNameMap = (
  agents: readonly LogisticsAgent[],
): Map<number, string> => new Map(agents.map((a) => [a.id, a.name]));
