/**
 * The maintenance write gate: one refuse trigger per write event on every
 * table an update's migrations derive from. The trigger reads the operator's
 * `maintenance_gate` setting directly, so it binds every writer the database
 * sees. That includes an isolate still running the previous bundle. The
 * exempt tables are the two the migration runner itself writes. The others
 * are the operator's own update flow: signing in, the audit trail, and
 * rate limiting.
 */

import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import { SCHEMA_TABLE_NAMES } from "./tables.ts";
import type { Trigger } from "./types.ts";
import { SCHEMA_MIGRATIONS_TABLE } from "./version.ts";

/** Tables that stay writable while the gate is engaged. */
export const GATE_EXEMPT_TABLES: ReadonlySet<string> = new Set([
  "activity_log",
  "login_attempts",
  SCHEMA_MIGRATIONS_TABLE,
  "sessions",
  "settings",
  "token_attempts",
]);

const GATED_TABLES = SCHEMA_TABLE_NAMES.filter(
  (name) => !GATE_EXEMPT_TABLES.has(name),
);

const refuseStatement = (
  event: "delete" | "insert" | "update",
  table: string,
): Trigger => ({
  name: `trg_${table}_maintenance_gate_${event}`,
  sql:
    `CREATE TRIGGER IF NOT EXISTS trg_${table}_maintenance_gate_${event}\n` +
    `BEFORE ${event.toUpperCase()} ON ${table}\n` +
    "WHEN (SELECT value FROM settings" +
    ` WHERE key = '${CONFIG_KEYS.MAINTENANCE_GATE}') = 'true'\n` +
    "BEGIN\n" +
    "  SELECT RAISE(ABORT, 'site is in maintenance mode');\n" +
    "END",
  table,
  uses: { settings: ["key", "value"] },
});

/** Three refuse triggers per gated table, in stable registry order. */
export const MAINTENANCE_GATE_TRIGGERS: Trigger[] = GATED_TABLES.flatMap(
  (table) =>
    (["insert", "update", "delete"] as const).map((event) =>
      refuseStatement(event, table),
    ),
);

export const MAINTENANCE_GATE_TRIGGER_NAMES = MAINTENANCE_GATE_TRIGGERS.map(
  ({ name }) => name,
);
