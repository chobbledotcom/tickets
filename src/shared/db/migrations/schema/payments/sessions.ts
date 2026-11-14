import {
  aboutTheRow,
  defaulted,
  requiredTextKey,
  text,
  textOrNull,
  wholeNumberOrNull,
  wholeNumberStartingAtOne,
} from "#db/migrations/schema/scalar-columns.ts";
import type { Table } from "#db/migrations/schema/types.ts";
import { madeAndTouched, ownerEncryptedRuleOrNull } from "./columns.ts";
import { sql } from "#db/sql.ts";

const HIDDEN_COLUMNS = [
  "session_resource",
  "booking_intent",
  "checkout_create",
  "result",
  "ticket_tokens",
  "completion",
  "legacy_runtime",
];

/** The only rule the table keeps: the buyer's details really are hidden. The
 *  rule carries its own brackets because it hangs on a whole row, not on the
 *  column it rides on. */
const ABOUT_THE_PAYMENT = HIDDEN_COLUMNS.map(
  (name) => sql`(${ownerEncryptedRuleOrNull(name)})`,
);

export const paymentSessionTable: [name: string, table: Table] = [
  "payment_sessions",
  {
    columns: [
      // SQLite lets a text primary key hold NULL, so the key says NOT NULL
      // outright rather than relying on being the key.
      ["id", requiredTextKey],
      ["origin", text],
      ["provider", textOrNull],
      ["mode", textOrNull],
      ["account_id", textOrNull],
      ["session_resource", textOrNull],
      ["session_reference_index", textOrNull],
      ["expected_amount", wholeNumberOrNull],
      ["expected_currency", textOrNull],
      ["booking_intent", textOrNull],
      ["checkout_create", textOrNull],
      ["state", text],
      ["revision", wholeNumberStartingAtOne],
      ...madeAndTouched,
      ["lease_token", textOrNull],
      ["lease_expires_at", wholeNumberOrNull],
      ["next_reconcile_at", wholeNumberOrNull],
      ["attendee_id", wholeNumberOrNull],
      ["result_state", defaulted(text, "none")],
      ["result", textOrNull],
      ["ticket_state", defaulted(text, "none")],
      ["ticket_tokens", textOrNull],
      ["completion_state", defaulted(text, "none")],
      ["completion", textOrNull],
      ["redacted_at", wholeNumberOrNull],
      ["legacy_runtime", aboutTheRow(ABOUT_THE_PAYMENT)(textOrNull)],
    ],
    indexes: [
      {
        columns: ["session_reference_index"],
        name: "idx_payment_sessions_reference",
        unique: true,
      },
      {
        columns: ["next_reconcile_at", "lease_expires_at", "id"],
        name: "idx_payment_sessions_reconcile",
      },
      {
        columns: ["attendee_id"],
        name: "idx_payment_sessions_attendee",
      },
      {
        columns: ["redacted_at", "updated_at", "id"],
        name: "idx_payment_sessions_redaction",
      },
    ],
  },
];
