import { executeBatch } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import { schemaMigration } from "./define.ts";

const LEGACY_REVISION_TRIGGERS = ["insert", "update", "delete"].map(
  (action) => `trg_checkout_stages_revision_${action}`,
);

export default schemaMigration(
  "2026-07-16_drop_checkout_stage_revisions",
  "Remove unused checkout stage revision tracking.",
  { absentTables: ["checkout_stage_revisions"] },
  async () => {
    await executeBatch([
      ...LEGACY_REVISION_TRIGGERS.map(
        (trigger) => sql`DROP TRIGGER IF EXISTS ${TODO_SQL_TEXT(trigger)}`,
      ),
      sql`DROP TABLE IF EXISTS checkout_stage_revisions`,
    ]);
  },
);
