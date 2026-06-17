import type {
  Migration,
  MigrationContext,
  SchemaRequirement,
} from "./types.ts";

const requires: SchemaRequirement = {
  columns: { questions: ["sort_order"] },
};

export default function questionSortOrderMigration({
  additive,
  applySchemaChanges,
  getDb,
}: MigrationContext): Migration {
  return additive({
    description:
      "Add a single global sort_order per question (replacing per-listing ordering); backfill existing questions from their row id to preserve creation order",
    id: "2026-06-14_question_sort_order",
    requires,
    up: async () => {
      await applySchemaChanges();
      // One-time backfill: existing rows all default to 0, so seed each from
      // its id (distinct, creation-ordered). New questions are assigned a
      // non-zero sort_order on creation, so this never re-touches them.
      await getDb().execute(
        "UPDATE questions SET sort_order = id WHERE sort_order = 0",
      );
    },
  });
}
