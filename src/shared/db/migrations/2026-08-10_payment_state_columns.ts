import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-08-10_payment_state_columns",
  "Add two payment-state columns to processed_payments: the plain live-work mirror that pruning and orphan selection read without decrypting, and the blind one-way reference index that lets a refund claim see another row holding the same provider money",
  {
    columns: {
      processed_payments: ["protected_state", "payment_reference_index"],
    },
    indexes: ["idx_processed_payments_reference_index"],
  },
);
