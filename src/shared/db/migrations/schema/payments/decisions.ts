import type { Table } from "#db/migrations/schema/types.ts";
import {
  encryptedPaymentColumn,
  encryptedPaymentColumnOrNull,
  wholeNumber,
  wholeNumberOrNull,
  words,
} from "./columns.ts";

/** What a decision may never be, whatever else is true of it. */
export const paymentCaseDecisionTable: [name: string, table: Table] = [
  "payment_case_decisions",
  {
    columns: [
      ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
      ["case_id", wholeNumber()],
      ["case_revision", wholeNumber()],
      ["claim", encryptedPaymentColumn("claim")],
      ["decision", `TEXT CHECK ${encryptedPaymentColumnOrNull("decision")}`],
      ["state", words()],
      ["attempt_count", wholeNumber(0)],
      ["created_at", wholeNumber()],
      ["last_attempt_at", wholeNumberOrNull()],
      ["next_retry_at", wholeNumberOrNull()],
      [
        "last_error",
        `TEXT\n          CHECK ${encryptedPaymentColumnOrNull("last_error")}`,
      ],
    ],
    indexes: [
      {
        columns: ["case_id", "case_revision"],
        name: "idx_payment_case_decisions_revision",
        unique: true,
      },
      {
        columns: ["state", "next_retry_at", "id"],
        name: "idx_payment_case_decisions_retry",
      },
    ],
  },
];
