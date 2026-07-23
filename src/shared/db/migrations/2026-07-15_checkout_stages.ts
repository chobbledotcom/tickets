import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-07-15_checkout_stages",
  "Add dormant checkout stage storage.",
  {
    indexes: [
      "idx_checkout_stages_attendee_id",
      "idx_checkout_stages_next_attempt",
    ],
    newTables: ["checkout_stages"],
  },
);
