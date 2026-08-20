import { executeBatch } from "#db/client.ts";
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
      ...LEGACY_REVISION_TRIGGERS.map((trigger) => ({
        args: [],
        sql: `DROP TRIGGER IF EXISTS ${trigger}`,
      })),
      { args: [], sql: "DROP TABLE IF EXISTS checkout_stage_revisions" },
    ]);
  },
);
