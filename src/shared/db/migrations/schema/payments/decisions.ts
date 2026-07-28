import type { Table } from "#shared/db/migrations/schema/types.ts";
import { DECISION_STATES } from "#shared/payment-state/words.ts";
import {
  alsoAbout,
  encryptedPaymentColumn,
  encryptedPaymentColumnOrNull,
  oneOf,
  wholeNumber,
  wholeNumberOrNull,
} from "./columns.ts";

/** What a decision may never be, whatever else is true of it. */
const aboutTheDecision = alsoAbout([
  "(attempt_count = 0) = (last_attempt_at IS NULL)",
  "next_retry_at IS NULL OR last_attempt_at IS NULL OR next_retry_at >= last_attempt_at",
]);

export const paymentCaseDecisionTable: [name: string, table: Table] = [
  "payment_case_decisions",
  {
    columns: [
      ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
      ["case_id", wholeNumber("case_id", 1)],
      ["case_revision", wholeNumber("case_revision", 1)],
      ["claim", encryptedPaymentColumn("claim")],
      ["decision", `TEXT CHECK ${encryptedPaymentColumnOrNull("decision")}`],
      ["state", oneOf("state", DECISION_STATES)],
      ["attempt_count", wholeNumber("attempt_count", 0, 0)],
      ["created_at", wholeNumber("created_at")],
      ["last_attempt_at", wholeNumberOrNull("last_attempt_at", "created_at")],
      ["next_retry_at", wholeNumberOrNull("next_retry_at", "created_at")],
      [
        "last_error",
        aboutTheDecision(
          `TEXT\n          CHECK ${encryptedPaymentColumnOrNull("last_error")}`,
        ),
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
