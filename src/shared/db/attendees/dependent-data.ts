/** How stored rows tied to an attendee behave when that attendee is deleted. */

export type AttendeeDataRule =
  | {
      action: "delete";
      field: string;
      kind: "direct";
      table: string;
    }
  | {
      action: "repoint";
      field: string;
      kind: "direct";
      table: string;
    }
  | {
      action: "retain";
      field: string;
      kind: "direct";
      table: string;
    }
  | {
      action: "delete";
      attendeeField: string;
      joinedField: string;
      joinedTable: string;
      kind: "through";
      table: string;
      tableField: string;
    }
  | {
      action: "delete";
      kind: "notes";
      table: "system_notes";
    }
  | {
      action: "retain";
      kind: "payment_history";
      table: string;
    };

/** The direct rule for one table's attendee column, with the action fixed by
 * the first call. The single shape for every plain attendee-id entry. */
const direct =
  (action: "delete" | "repoint" | "retain") =>
  (table: string, field = "attendee_id"): AttendeeDataRule => ({
    action,
    field,
    kind: "direct",
    table,
  });

/** The retained durable-payment tables. */
const retainHistory = (table: string): AttendeeDataRule => ({
  action: "retain",
  kind: "payment_history",
  table,
});

/**
 * Every direct attendee-id column, plus dependent rows reached through another
 * key. Delete planning consumes this list directly. Retained entries make the
 * exceptions explicit without turning them into deletes.
 */
export const ATTENDEE_DATA_RULES: readonly AttendeeDataRule[] = [
  direct("delete")("checkout_stages"),
  {
    action: "delete",
    attendeeField: "attendee_id",
    joinedField: "identity",
    joinedTable: "refund_confirmations",
    kind: "through",
    table: "refund_confirmation_references",
    tableField: "confirmation_identity",
  },
  direct("delete")("refund_confirmations"),
  direct("delete")("processed_payments"),
  direct("delete")("attendee_answers"),
  direct("delete")("booking_tax_assessments"),
  direct("delete")("answers_at_booking"),
  direct("delete")("listing_attendees"),
  direct("delete")("service_costs", "servicing_attendee_id"),
  { action: "delete", kind: "notes", table: "system_notes" },

  // Activity and modifier rows are historical ledgers. In-flight SMS rows
  // retire on their provider callback or age prune, not with the attendee.
  direct("retain")("activity_log"),
  direct("retain")("modifier_usages"),
  direct("retain")("sms_messages"),

  // A built site's assignment follows the person through a merge. A deletion
  // clears only that live link. The provisioned site keeps its own lifecycle.
  direct("repoint")("built_sites", "assigned_attendee_id"),
  // A durable payment session has a lifecycle of its own. Its eventual
  // detach/redaction rule must not be guessed by an attendee purge.
  direct("retain")("payment_sessions"),
  // The aggregate's child rows stay with its durable payment history. Keeping
  // every payment table in this schema means a new child cannot silently miss
  // the attendee-deletion decision.
  retainHistory("payment_completion_effects"),
  retainHistory("payment_completion_deliveries"),
  retainHistory("payment_charges"),
  retainHistory("payment_cases"),
  retainHistory("payment_case_decisions"),
];
