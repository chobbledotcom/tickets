import { bareSchemaMigration } from "./define.ts";

export default bareSchemaMigration(
  "2026-07-17_checkout_stage_provider_id",
  "Replace dormant checkout stages with the runtime schema.",
  async ({ getDb, recreateTable }) => {
    // Stages written before runtime checkout processing were never actionable.
    await getDb().execute("DELETE FROM checkout_stages");
    await recreateTable("checkout_stages");
  },
);
