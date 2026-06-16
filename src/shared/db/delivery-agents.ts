/**
 * Delivery agents table operations.
 *
 * A delivery agent is a simple named entity (typically a van) used to record
 * who drops off and collects equipment-hire bookings. Names are encrypted at
 * rest, matching the treatment of other owner-entered labels (e.g. holidays).
 */

import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { encryptedNameSchema } from "#shared/db/common-schema.ts";
import { queryAndMap } from "#shared/db/query.ts";
import { cachedTable, col, defineTable } from "#shared/db/table.ts";
import type { DeliveryAgent } from "#shared/types.ts";

/** Delivery agent input fields for create/update (camelCase). */
export type DeliveryAgentInput = {
  name: string;
};

/** Raw delivery_agents table — name is encrypted, id is generated. */
const rawDeliveryAgentsTable = defineTable<DeliveryAgent, DeliveryAgentInput>({
  name: "delivery_agents",
  primaryKey: "id",
  schema: {
    id: col.generated<number>(),
    ...encryptedNameSchema(encrypt, decrypt),
  },
});

/** Execute a query and decrypt the resulting delivery agent rows. */
const queryDeliveryAgents = queryAndMap<DeliveryAgent, DeliveryAgent>((row) =>
  rawDeliveryAgentsTable.fromDb(row),
);

const deliveryAgentsCache = cachedTable({
  fetchAll: () =>
    queryDeliveryAgents("SELECT * FROM delivery_agents ORDER BY id ASC"),
  name: "delivery_agents",
  table: rawDeliveryAgentsTable,
});

/** Delivery agents table with CRUD operations — writes auto-invalidate the cache. */
export const deliveryAgentsTable = deliveryAgentsCache.table;

/** Invalidate the delivery agents cache (for testing or after writes). */
export const invalidateDeliveryAgentsCache = (): void => {
  deliveryAgentsCache.invalidate();
};

/** Get all delivery agents, decrypted, ordered by id (from cache). */
export const getAllDeliveryAgents = (): Promise<DeliveryAgent[]> =>
  deliveryAgentsCache.getAll();
