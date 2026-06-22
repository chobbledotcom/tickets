import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-22_transfers_time_int",
  "Store transfers.occurred_at and recorded_at as INTEGER epoch-millis (was TEXT ISO) so the indexed time column sorts and ranges chronologically with integer comparisons at high transfer volumes; the Phase-0 table is not yet written to, so rebuilding it from the current schema is data-safe",
  // recreateTable rebuilds transfers from the current SCHEMA (now INTEGER time
  // columns), so this migration re-asserts the table's full shape; an additive
  // schema sync alone cannot change an existing column's type.
  { newTables: ["transfers"] },
  ({ recreateTable }) => recreateTable("transfers"),
);
