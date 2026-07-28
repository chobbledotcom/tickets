import { schemaMigration } from "./define.ts";

/**
 * The tables one payment record lives in.
 *
 * Nothing writes to them yet. The code that does — the repositories, the
 * runtime, and the copy that brings older payments across — follows in its own
 * changes, so each arrives small enough to read.
 */
export default schemaMigration(
  "2026-07-26_payment_records",
  "Create the tables one payment record lives in.",
  {
    indexes: [
      "idx_payment_case_decisions_retry",
      "idx_payment_case_decisions_revision",
      "idx_payment_cases_alert",
      "idx_payment_cases_payment_resource",
      "idx_payment_cases_reconcile",
      "idx_payment_cases_redaction",
      "idx_payment_charges_legacy_source",
      "idx_payment_charges_payment_reference",
      "idx_payment_charges_pending_refund",
      "idx_payment_charges_reference",
      "idx_payment_completion_deliveries_pending",
      "idx_payment_completion_deliveries_unique",
      "idx_payment_completion_effects_unique",
      "idx_payment_sessions_attendee",
      "idx_payment_sessions_reconcile",
      "idx_payment_sessions_redaction",
      "idx_payment_sessions_reference",
    ],
    newTables: [
      "payment_sessions",
      "payment_completion_effects",
      "payment_completion_deliveries",
      "payment_charges",
      "payment_cases",
      "payment_case_decisions",
    ],
  },
);
