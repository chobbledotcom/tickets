/** Assembles the ordered schema and computes its identity hash. */

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
];

/** Ordered table names — matches FK dependency order (parents before children) */
export const SCHEMA_TABLE_NAMES: string[] = SCHEMA.map(([name]) => name);

// ─── Schema hash (auto-detects changes even if LATEST_UPDATE isn't bumped) ──

/** DJB2 hash — deterministic, fast, good enough for change detection */
const djb2 = (str: string): string => {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
};

export const APP_SCHEMA = SCHEMA.filter(
  ([name]) => name !== SCHEMA_MIGRATIONS_TABLE,
);
const STORED_SCHEMA_TRIGGERS = TRIGGERS.map(
  ({ restore: _restore, ...trigger }) => trigger,
);

// Triggers join the hash input so changing a trigger's SQL re-runs migrations
// even if no column/index changed (the same safety net columns already have).
// Restore timing is runtime metadata, not part of the stored database schema.
export const SCHEMA_HASH = djb2(
  JSON.stringify([APP_SCHEMA, STORED_SCHEMA_TRIGGERS]),
);
