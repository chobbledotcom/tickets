import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-10-20_processed_scan_operations",
  "Record the operation id and token digest queued offline check-in deliveries have claimed, with the listings and the quantity each delivery's admission took, so a retried delivery cannot admit a second ticket while a reused id cannot suppress another ticket's admission",
  {
    indexes: ["idx_processed_scan_operations_delivery"],
    newTables: ["processed_scan_operations"],
  },
);
