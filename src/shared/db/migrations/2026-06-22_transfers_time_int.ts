import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-22_transfers_time_int",
  "Store transfers.occurred_at and recorded_at as INTEGER epoch-millis (was TEXT ISO) so the indexed time column sorts and ranges chronologically with integer comparisons at high transfer volumes; the Phase-0 table is not yet written to, so rebuilding it from the current schema is data-safe",
  // recreateTable rebuilds transfers from the current SCHEMA (now INTEGER time
  // columns), so this migration re-asserts the table's full shape; an additive
  // schema sync alone cannot change an existing column's type.
  { newTables: ["transfers"] },
  async ({ getDb, recreateTable }) => {
    // recreateTable copies matching columns verbatim, which would land old ISO
    // TEXT values in the new INTEGER columns (read back as NaN). The ledger is
    // not yet written in production (Phase 0), so the table must be empty here —
    // refuse loudly rather than silently corrupt it, instead of writing an
    // ISO→epoch conversion for a state the application says cannot exist. A
    // populated table needs an explicit, reviewed conversion before this runs.
    const existing = await getDb().execute("SELECT 1 FROM transfers LIMIT 1");
    if (existing.rows.length > 0) {
      throw new Error(
        "transfers is not empty; refusing to retype occurred_at/recorded_at to " +
          "INTEGER by verbatim rebuild — convert the ISO timestamps explicitly first",
      );
    }
    await recreateTable("transfers");
  },
);
