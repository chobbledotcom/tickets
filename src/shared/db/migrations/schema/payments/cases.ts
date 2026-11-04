/* jscpd:ignore-start -- imports */
import {
  text,
  textOrNull,
  wholeNumber,
  wholeNumberOrNull,
  wholeNumberStartingAtOne,
} from "#db/migrations/schema/scalar-columns.ts";
import { ownerEncryptedColumn, paymentRecord } from "./columns.ts";
/* jscpd:ignore-end */

export const paymentCaseTable = paymentRecord("payment_cases", {
  columns: [
    ownerEncryptedColumn("resource"),
    ["resource_index", text],
    ["reason", text],
    ["state", text],
    ["first_observed_at", wholeNumber],
    ["last_observed_at", wholeNumber],
    ["next_reconcile_at", wholeNumberOrNull],
    ["consecutive_count", wholeNumber],
    ["alerted_at", wholeNumberOrNull],
    ["alerted_revision", wholeNumberOrNull],
    ["alert_sent_at", wholeNumberOrNull],
    ["alert_sent_revision", wholeNumberOrNull],
    // An empty claim matches another empty one, so two workers can both
    // send the owner the same alert.
    ["alert_lease_token", textOrNull],
    ["alert_lease_expires_at", wholeNumberOrNull],
    ownerEncryptedColumn("evidence"),
    ["evidence_redacted_at", wholeNumberOrNull],
    ["revision", wholeNumberStartingAtOne],
    ["resolved_at", wholeNumberOrNull],
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
