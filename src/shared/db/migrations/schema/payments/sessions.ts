/* jscpd:ignore-start -- imports */
import type { Table } from "#shared/db/migrations/schema/types.ts";
import {
  alsoAbout,
  encryptedPaymentColumnOrNull,
  keyWords,
  madeAndTouched,
  wholeNumber,
  wholeNumberOrNull,
  words,
  wordsOrNull,
} from "./columns.ts";

/* jscpd:ignore-end */

const HIDDEN_COLUMNS = [
  "session_resource",
  "booking_intent",
  "checkout_create",
  "result",
  "ticket_tokens",
  "completion",
  "legacy_runtime",
];

/** The only rule the table keeps: the buyer's details really are hidden. */
const aboutThePayment = alsoAbout(
  HIDDEN_COLUMNS.map(encryptedPaymentColumnOrNull),
);

export const paymentSessionTable: [name: string, table: Table] = [
  "payment_sessions",
  {
    columns: [
      // SQLite lets a text primary key hold NULL, so the key says NOT NULL
      // outright rather than relying on being the key.
      ["id", keyWords()],
      ["origin", words()],
      ["provider", wordsOrNull()],
      ["mode", wordsOrNull()],
      ["account_id", wordsOrNull()],
      ["session_resource", wordsOrNull()],
      ["session_reference_index", wordsOrNull()],
      ["expected_amount", wholeNumberOrNull()],
      ["expected_currency", wordsOrNull()],
      ["booking_intent", wordsOrNull()],
      ["checkout_create", wordsOrNull()],
      ["state", words()],
      ["revision", wholeNumber(1)],
      ...madeAndTouched,
      ["lease_token", wordsOrNull()],
      ["lease_expires_at", wholeNumberOrNull()],
      ["next_reconcile_at", wholeNumberOrNull()],
      ["attendee_id", wholeNumberOrNull()],
      ["result_state", words("none")],
      ["result", wordsOrNull()],
      ["ticket_state", words("none")],
      ["ticket_tokens", wordsOrNull()],
      ["completion_state", words("none")],
      ["completion", wordsOrNull()],
      ["redacted_at", wholeNumberOrNull()],
      ["legacy_runtime", aboutThePayment(wordsOrNull())],
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
