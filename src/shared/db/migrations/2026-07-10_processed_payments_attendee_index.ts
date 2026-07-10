import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-07-10_processed_payments_attendee_index",
  "Add idx_processed_payments_attendee so the refund-reference lookups " +
    "(getRefundPaymentReferences, getAttendeeIdsWithPaymentReference: WHERE " +
    "attendee_id IN (…)) seek straight to an attendee's charges instead of " +
    "full-scanning every retained payment row from the roster, export, and " +
    "refund-all pages.",
  {
    indexes: ["idx_processed_payments_attendee"],
  },
);
