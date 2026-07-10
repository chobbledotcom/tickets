import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-07-10_processed_payments_attendee_index",
  "Add idx_processed_payments_attendee_id so admin rosters, exports, and " +
    "refund-all candidate loading range-scan a listing's retained charge " +
    "references (attendee_id IN (...) AND payment_reference != '') instead of " +
    "full-scanning every retained processed_payments row.",
  {
    indexes: ["idx_processed_payments_attendee_id"],
  },
);
