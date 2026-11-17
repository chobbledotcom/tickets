import { fullSchemaCreateStatements } from "#db/migrations/schema-sync.ts";
import type { SqlStatement } from "#db/sql.ts";
import { compact } from "#fp";
import { TRIGGERS } from "./triggers.ts";
import type { Trigger } from "./types.ts";

export interface RestoreDeferredIndex {
  name: string;
  sql: SqlStatement;
}

const NON_UNIQUE_INDEX = /^CREATE INDEX IF NOT EXISTS (.+?) ON /;

/** A unique index stays in place for restore, so it gives null here. */
const restoreDeferredIndexOrNull = (
  statement: SqlStatement,
): RestoreDeferredIndex | null => {
  const found = NON_UNIQUE_INDEX.exec(statement.sql);
  return found === null ? null : { name: found[1]!, sql: statement };
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
