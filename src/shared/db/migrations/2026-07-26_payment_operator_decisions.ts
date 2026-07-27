import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-07-26_payment_operator_decisions",
  "Record owner payment decisions with revision fencing and encrypted evidence.",
  {
    indexes: [
      "idx_payment_case_decisions_revision",
      "idx_payment_case_decisions_retry",
    ],
    newTables: ["payment_case_decisions"],
  },
);
