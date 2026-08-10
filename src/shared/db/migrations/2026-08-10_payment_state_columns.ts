import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-08-10_payment_state_columns",
  "Add the M4 payment-state columns to processed_payments: the committed-evidence replay fingerprint, the plain live-work mirror that pruning and orphan selection read without decrypting, and the blind one-way reference index that lets a refund claim see another row holding the same provider money",
  {
    columns: {
      processed_payments: [
        "evidence_index",
        "protected_state",
        "payment_reference_index",
      ],
    },
    indexes: ["idx_processed_payments_reference_index"],
  },
);
