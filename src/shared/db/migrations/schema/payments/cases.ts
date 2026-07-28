import { CASE_STATES } from "#shared/payment-state/words.ts";
import {
  alsoAbout,
  encryptedPaymentColumn,
  oneOf,
  paymentRecord,
  wholeNumber,
  wholeNumberOrNull,
  words,
  wordsOrNull,
} from "./columns.ts";

/** What a case may never be, whatever else is true of it. */
const aboutTheCase = alsoAbout([
  `resolved_at IS NULL OR (typeof(resolved_at) = 'integer' AND resolved_at >= last_observed_at)`,
  "(alerted_at IS NULL) = (alerted_revision IS NULL)",
  "alerted_at IS NULL OR alerted_at >= first_observed_at",
  "alerted_revision IS NULL OR alerted_revision <= revision",
  "(alert_sent_at IS NULL) = (alert_sent_revision IS NULL)",
  "alert_sent_revision IS NULL OR (alerted_revision IS NOT NULL AND alert_sent_revision = alerted_revision)",
  "alert_sent_at IS NULL OR (alerted_at IS NOT NULL AND alert_sent_at >= alerted_at)",
  "(alert_lease_token IS NULL) = (alert_lease_expires_at IS NULL)",
  `alert_lease_expires_at IS NULL OR (typeof(alert_lease_expires_at) = 'integer' AND alert_lease_expires_at >= first_observed_at)`,
]);

export const paymentCaseTable = paymentRecord("payment_cases", {
  columns: [
    ["resource", encryptedPaymentColumn("resource")],
    ["resource_index", words("resource_index")],
    ["reason", words("reason")],
    ["state", oneOf("state", CASE_STATES)],
    ["first_observed_at", wholeNumber("first_observed_at")],
    ["last_observed_at", wholeNumber("last_observed_at", "first_observed_at")],
    ["next_reconcile_at", wholeNumberOrNull("next_reconcile_at")],
    ["consecutive_count", wholeNumber("consecutive_count", 1)],
    ["alerted_at", wholeNumberOrNull("alerted_at")],
    ["alerted_revision", wholeNumberOrNull("alerted_revision", 1)],
    ["alert_sent_at", wholeNumberOrNull("alert_sent_at")],
    ["alert_sent_revision", wholeNumberOrNull("alert_sent_revision", 1)],
    // An empty claim would match another empty one, so two workers could
    // both send the owner the same alert.
    ["alert_lease_token", wordsOrNull("alert_lease_token")],
    ["alert_lease_expires_at", wholeNumberOrNull("alert_lease_expires_at")],
    ["evidence", encryptedPaymentColumn("evidence")],
    [
      "evidence_redacted_at",
      wholeNumberOrNull("evidence_redacted_at", "resolved_at"),
    ],
    ["revision", wholeNumber("revision", 1, 1)],
    ["resolved_at", aboutTheCase("INTEGER")],
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
