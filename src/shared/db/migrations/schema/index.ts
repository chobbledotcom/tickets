/** Assembles the ordered schema and computes its identity hash. */

import { SCHEMA, SCHEMA_TABLE_NAMES } from "./tables.ts";
import { TRIGGERS } from "./triggers.ts";
import { SCHEMA_MIGRATIONS_TABLE } from "./version.ts";

export { SCHEMA, SCHEMA_TABLE_NAMES };

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
