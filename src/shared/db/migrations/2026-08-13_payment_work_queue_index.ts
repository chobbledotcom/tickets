import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-08-13_payment_work_queue_index",
  "Index the small set of protected payment rows so the owner recovery queue does not scan ordinary payments.",
  { indexes: ["idx_processed_payments_protected_attendee"] },
);
