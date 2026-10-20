import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-10-20_processed_scan_operations",
  "Record the operation ids queued offline check-in deliveries have claimed, so a retried delivery cannot admit a second ticket",
  { indexes: [], newTables: ["processed_scan_operations"] },
);
