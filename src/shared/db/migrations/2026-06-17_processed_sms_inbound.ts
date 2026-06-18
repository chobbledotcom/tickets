import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-17_processed_sms_inbound",
  "Add processed_sms_inbound table for inbound SMS webhook replay protection",
  {
    indexes: ["idx_processed_sms_inbound_created"],
    newTables: ["processed_sms_inbound"],
  },
);
