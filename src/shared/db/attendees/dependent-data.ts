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

/**
 * Every direct attendee-id column, plus dependent rows reached through another
 * key. Delete planning consumes this list directly; retained entries make the
 * exceptions explicit without turning them into deletes.
 */
export const ATTENDEE_DATA_RULES: readonly AttendeeDataRule[] = [
  {
    action: "delete",
    field: "attendee_id",
    kind: "direct",
    table: "checkout_stages",
  },
  {
    action: "delete",
    attendeeField: "attendee_id",
    joinedField: "identity",
    joinedTable: "refund_confirmations",
    kind: "through",
    table: "refund_confirmation_references",
    tableField: "confirmation_identity",
  },
  {
    action: "delete",
    field: "attendee_id",
    kind: "direct",
    table: "refund_confirmations",
  },
  {
    action: "delete",
    field: "attendee_id",
    kind: "direct",
    table: "processed_payments",
  },
  {
    action: "delete",
    field: "attendee_id",
    kind: "direct",
    table: "attendee_answers",
  },
  {
    action: "delete",
    field: "attendee_id",
    kind: "direct",
    table: "listing_attendees",
  },
  {
    action: "delete",
    field: "servicing_attendee_id",
    kind: "direct",
    table: "service_costs",
  },
  { action: "delete", kind: "notes", table: "system_notes" },

  // Activity and modifier rows are historical ledgers. In-flight SMS rows
  // retire on their provider callback or age prune, not with the attendee.
  {
    action: "retain",
    field: "attendee_id",
    kind: "direct",
    table: "activity_log",
  },
  {
    action: "retain",
    field: "attendee_id",
    kind: "direct",
    table: "modifier_usages",
  },
  {
    action: "retain",
    field: "attendee_id",
    kind: "direct",
    table: "sms_messages",
  },

  // A built site's assignment follows the person through a merge. A deletion
  // clears only that live link; the provisioned site keeps its own lifecycle.
  {
    action: "repoint",
    field: "assigned_attendee_id",
    kind: "direct",
    table: "built_sites",
  },
  // A durable payment session has a lifecycle of its own. Its eventual
  // detach/redaction rule must not be guessed by an attendee purge.
  {
    action: "retain",
    field: "attendee_id",
    kind: "direct",
    table: "payment_sessions",
  },
  // The aggregate's child rows stay with its durable payment history. Keeping
  // every payment table in this schema means a new child cannot silently miss
  // the attendee-deletion decision.
  {
    action: "retain",
    kind: "payment_history",
    table: "payment_completion_effects",
  },
  {
    action: "retain",
    kind: "payment_history",
    table: "payment_completion_deliveries",
  },
  { action: "retain", kind: "payment_history", table: "payment_charges" },
  { action: "retain", kind: "payment_history", table: "payment_cases" },
  {
    action: "retain",
    kind: "payment_history",
    table: "payment_case_decisions",
  },
];
