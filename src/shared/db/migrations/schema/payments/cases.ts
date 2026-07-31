import {
  encryptedPaymentColumn,
  paymentRecord,
  wholeNumber,
  wholeNumberOrNull,
  words,
  wordsOrNull,
} from "./columns.ts";

export const paymentCaseTable = paymentRecord("payment_cases", {
  columns: [
    ["resource", encryptedPaymentColumn("resource")],
    ["resource_index", words()],
    ["reason", words()],
    ["state", words()],
    ["first_observed_at", wholeNumber()],
    ["last_observed_at", wholeNumber()],
    ["next_reconcile_at", wholeNumberOrNull()],
    ["consecutive_count", wholeNumber()],
    ["alerted_at", wholeNumberOrNull()],
    ["alerted_revision", wholeNumberOrNull()],
    ["alert_sent_at", wholeNumberOrNull()],
    ["alert_sent_revision", wholeNumberOrNull()],
    // An empty claim would match another empty one, so two workers could
    // both send the owner the same alert.
    ["alert_lease_token", wordsOrNull()],
    ["alert_lease_expires_at", wholeNumberOrNull()],
    ["evidence", encryptedPaymentColumn("evidence")],
    ["evidence_redacted_at", wholeNumberOrNull()],
    ["revision", wholeNumber(1)],
    ["resolved_at", wholeNumberOrNull()],
  ],
  indexes: [
    {
      columns: ["payment_id", "resource_index"],
      name: "idx_payment_cases_payment_resource",
      unique: true,
    },
    {
      columns: ["state", "next_reconcile_at", "id"],
      name: "idx_payment_cases_reconcile",
    },
    {
      columns: [
        "state",
        "alert_sent_revision",
        "alert_lease_expires_at",
        "alerted_at",
        "id",
      ],
      name: "idx_payment_cases_alert",
    },
    {
      columns: ["evidence_redacted_at", "id"],
      name: "idx_payment_cases_redaction",
    },
  ],
});
