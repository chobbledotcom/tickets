import type {
  Migration,
  MigrationContext,
  SchemaRequirement,
} from "./types.ts";

const requires: SchemaRequirement = {
  columns: { modifiers: ["code"] },
};

export default function modifierCodeMigration({
  additive,
  applySchemaChanges,
}: MigrationContext): Migration {
  return additive({
    description:
      "Add an encrypted code column to modifiers for promo-code (trigger=code) modifiers; the public code box matches against code_index",
    id: "2026-06-17_modifier_code",
    requires,
    up: applySchemaChanges,
  });
}
