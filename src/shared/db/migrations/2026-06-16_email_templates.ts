import type {
  Migration,
  MigrationContext,
  SchemaRequirement,
} from "./types.ts";

const requires: SchemaRequirement = {
  newTables: ["email_templates"],
};

export default function emailTemplatesMigration({
  additive,
  applySchemaChanges,
}: MigrationContext): Migration {
  return additive({
    description:
      "Add email_templates table for owner-keypair-encrypted reusable email subjects and bodies",
    id: "2026-06-16_email_templates",
    requires,
    up: applySchemaChanges,
  });
}
