import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-09-28_submitted_answer_receipts",
  "Keep original answer wording for each booked line and retain owner-sealed submitted text",
  {
    indexes: [
      "idx_submitted_answer_receipt_lines_unique",
      "idx_submitted_answer_receipt_lines_string_id",
    ],
    newTables: ["submitted_answer_receipts", "submitted_answer_receipt_lines"],
    triggers: [
      "trg_submitted_answer_receipt_strings_insert",
      "trg_submitted_answer_receipt_strings_delete",
    ],
  },
);
