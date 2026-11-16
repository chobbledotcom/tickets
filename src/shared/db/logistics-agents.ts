/**
 * Logistics agents table operations.
 *
 * A logistics agent is a simple named entity (typically a van) used to record
 * who drops off and collects equipment-hire bookings. Names are encrypted at
 * rest, matching the treatment of other owner-entered labels (for example,
 * holidays).
 */

import { readRows } from "#db/read.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { tableCache } from "#db/table-cache.ts";
import { requestCache } from "#shared/request-cache.ts";

/** Logistics agent input fields for create/update (camelCase). */
export type LogisticsAgentInput = {
  name: string;
};

/** Every logistics agent in id order, cached for the request. The name is
 * decrypted by its codec. */
export const logisticsAgents = tableCache(
  tables.logistics_agents,
  requestCache(() =>
    readRows(from(tables.logistics_agents).sortedBy("id").everyColumn()),
  ),
);
