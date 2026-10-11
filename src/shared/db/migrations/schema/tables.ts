/** The ordered schema tables: groups concatenated in FK-dependency order, so
 *  parents sort before children and the sequence reproduces the original
 *  single-file declaration. */

import { paymentTables } from "./payments/index.ts";
import { attendeeTables } from "./tables-attendees.ts";
import { catalogTables } from "./tables-catalog.ts";
import { contentTables } from "./tables-content.ts";
import { coreTables } from "./tables-core.ts";
import { questionTables } from "./tables-questions.ts";
import type { Table } from "./types.ts";

export const SCHEMA: [name: string, table: Table][] = [
  ...coreTables,
  ...attendeeTables,
  ...catalogTables,
  ...questionTables,
  ...contentTables,
  ...paymentTables,
];

/** Ordered table names — matches FK dependency order (parents before children) */
export const SCHEMA_TABLE_NAMES: string[] = SCHEMA.map(([name]) => name);
