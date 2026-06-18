import type { Migration, MigrationContext } from "./types.ts";

export default function currentSchemaMigration({
  syncCurrentSchema,
  verifyCurrentAppSchema,
}: MigrationContext): Migration {
  return {
    // The baseline reconcile genuinely brings the WHOLE schema current from any
    // legacy shape, so it keeps the full-schema verification.
    description:
      "Reconcile legacy databases with the current declarative schema",
    id: "2026-06-11_current_schema",
    up: syncCurrentSchema,
    verify: verifyCurrentAppSchema,
  };
}
