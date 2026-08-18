/** Assembles the ordered schema and computes its identity hash. */

import { paymentTables } from "./payments/index.ts";
import { attendeeTables } from "./tables-attendees.ts";
import { catalogTables } from "./tables-catalog.ts";
import { contentTables } from "./tables-content.ts";
import { coreTables } from "./tables-core.ts";
import { questionTables } from "./tables-questions.ts";
import { TRIGGERS } from "./triggers.ts";
import type { Table } from "./types.ts";
import { SCHEMA_MIGRATIONS_TABLE } from "./version.ts";

// Schema (ordered: tables with no FK deps first). Concatenating the groups in
// this order reproduces the original FK-dependency sequence exactly, so the
// schema hash is unchanged from the single-file declaration.
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

// ─── Schema hash (auto-detects changes even if LATEST_UPDATE isn't bumped) ──

/** DJB2 hash — deterministic, fast, good enough for change detection */
const djb2 = (str: string): string => {
  const hash = str
    .split("")
    .reduce((sum, char) => ((sum << 5) + sum + char.charCodeAt(0)) | 0, 5381);
  return (hash >>> 0).toString(36);
};

export const APP_SCHEMA = SCHEMA.filter(
  ([name]) => name !== SCHEMA_MIGRATIONS_TABLE,
);

// Triggers join the hash input so changing a trigger's SQL re-runs migrations
// even if no column/index changed (the same safety net columns already have).
export const SCHEMA_HASH = djb2(JSON.stringify([APP_SCHEMA, TRIGGERS]));
