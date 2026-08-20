import { fullSchemaCreateStatements } from "#db/migrations/schema-sync.ts";
import { compact } from "#fp";
import { TRIGGERS } from "./triggers.ts";
import type { Trigger } from "./types.ts";

export interface RestoreDeferredIndex {
  name: string;
  sql: string;
}

const NON_UNIQUE_INDEX_PREFIX = "CREATE INDEX IF NOT EXISTS ";
const restoreDeferredIndexOrNull = (
  sql: string,
): RestoreDeferredIndex | null => {
  if (!sql.startsWith(NON_UNIQUE_INDEX_PREFIX)) return null;
  const nameEnd = sql.indexOf(" ON ", NON_UNIQUE_INDEX_PREFIX.length);
  return {
    name: sql.slice(NON_UNIQUE_INDEX_PREFIX.length, nameEnd),
    sql,
  };
};

/** Non-unique indexes rebuilt after bulk restore rows are loaded. */
export const RESTORE_DEFERRED_INDEXES: RestoreDeferredIndex[] = compact(
  fullSchemaCreateStatements().map(restoreDeferredIndexOrNull),
);

const RESTORE_ACTIVE_TRIGGER_NAMES: readonly string[] = [
  "trg_attendee_answers_validate_insert",
  "trg_attendee_answers_validate_update",
  "trg_attendees_validate_status_insert",
  "trg_attendees_validate_status_update",
];

/** Derived-state triggers rebuilt after stored backup values are loaded. */
export const RESTORE_DEFERRED_TRIGGERS: Trigger[] = TRIGGERS.filter(
  ({ name }) => !RESTORE_ACTIVE_TRIGGER_NAMES.includes(name),
);
