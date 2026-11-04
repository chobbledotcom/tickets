/* jscpd:ignore-start -- imports */
import {
  aboutTheRow,
  checked,
  rowId,
  text,
  textOrNull,
  wholeNumber,
  wholeNumberOrNull,
  wholeNumberStartingAtZero,
} from "#db/migrations/schema/scalar-columns.ts";
import type { Table } from "#db/migrations/schema/types.ts";
import { ownerEncryptedColumn, ownerEncryptedRuleOrNull } from "./columns.ts";
/* jscpd:ignore-end */

/** What a decision can never be, whatever else is true of it. */
export const paymentCaseDecisionTable: [name: string, table: Table] = [
  "payment_case_decisions",
  {
    columns: [
      ["id", rowId],
      ["case_id", wholeNumber],
      ["case_revision", wholeNumber],
      ownerEncryptedColumn("claim"),
      ["decision", checked(ownerEncryptedRuleOrNull("decision"))(textOrNull)],
      ["state", text],
      ["attempt_count", wholeNumberStartingAtZero],
      ["created_at", wholeNumber],
      ["last_attempt_at", wholeNumberOrNull],
      ["next_retry_at", wholeNumberOrNull],
      [
        "last_error",
        aboutTheRow([ownerEncryptedRuleOrNull("last_error")])(textOrNull),
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
