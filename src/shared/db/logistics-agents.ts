/**
 * Logistics agents table operations.
 *
 * A logistics agent is a simple named entity (typically a van) used to record
 * who drops off and collects equipment-hire bookings. Names are encrypted at
 * rest, matching the treatment of other owner-entered labels (for example,
 * holidays).
 */

import { tables } from "#db/select/tables.ts";
import { requestCachedRows } from "#db/table-cache.ts";

/** Logistics agent input fields for create/update (camelCase). */
export type LogisticsAgentInput = {
  name: string;
};

/** Every logistics agent in id order, cached for the request. The name is
 * decrypted by its codec. */
export const logisticsAgents = requestCachedRows(
  tables.logistics_agents,
  (rows) => rows.sortedBy("id").everyColumn(),
);
