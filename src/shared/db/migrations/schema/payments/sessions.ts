/* jscpd:ignore-start -- imports */
import type { Table } from "#shared/db/migrations/schema/types.ts";
import {
  COMPLETION_STATES,
  PAYMENT_MODES,
  PAYMENT_STATES,
  RECORD_ORIGINS,
  RESULT_STATES,
  TICKET_STATES,
} from "#shared/payment-state/words.ts";
import { PaymentProviderSchema } from "#shared/types.ts";
import {
  alsoAbout,
  amountOrNull,
  currencyOrNull,
  encryptedPaymentColumnOrNull,
  keyWords,
  madeAndTouched,
  oneOf,
  oneOfOrNull,
  wholeNumber,
  wholeNumberOrNull,
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

/** What a payment may never be, whatever else is true of it. */
const aboutThePayment = alsoAbout([
  "(lease_token IS NULL) = (lease_expires_at IS NULL)",
  "(session_resource IS NULL) = (session_reference_index IS NULL)",
  ...HIDDEN_COLUMNS.map(encryptedPaymentColumnOrNull),
]);

export const paymentSessionTable: [name: string, table: Table] = [
  "payment_sessions",
  {
    columns: [
      // SQLite lets a text primary key hold NULL, so the key says NOT NULL
      // outright rather than relying on being the key.
      ["id", keyWords("id")],
      ["origin", oneOf("origin", RECORD_ORIGINS)],
      ["provider", oneOfOrNull("provider", PaymentProviderSchema.options)],
      ["mode", oneOfOrNull("mode", PAYMENT_MODES)],
      ["account_id", wordsOrNull("account_id")],
      ["session_resource", "TEXT"],
      ["session_reference_index", wordsOrNull("session_reference_index")],
      ["expected_amount", amountOrNull("expected_amount", 0)],
      ["expected_currency", currencyOrNull("expected_currency")],
      ["booking_intent", "TEXT"],
      ["checkout_create", "TEXT"],
      ["state", oneOf("state", PAYMENT_STATES)],
      ["revision", wholeNumber("revision", 1, 1)],
      ...madeAndTouched,
      // An empty claim would match another empty one, so two workers could
      // both think they held the payment.
      ["lease_token", wordsOrNull("lease_token")],
      ["lease_expires_at", wholeNumberOrNull("lease_expires_at", "created_at")],
      [
        "next_reconcile_at",
        wholeNumberOrNull("next_reconcile_at", "created_at"),
      ],
      ["attendee_id", wholeNumberOrNull("attendee_id", 1)],
      ["result_state", oneOf("result_state", RESULT_STATES, "none")],
      ["result", "TEXT"],
      ["ticket_state", oneOf("ticket_state", TICKET_STATES, "none")],
      ["ticket_tokens", "TEXT"],
      [
        "completion_state",
        oneOf("completion_state", COMPLETION_STATES, "none"),
      ],
      ["completion", "TEXT"],
      ["redacted_at", wholeNumberOrNull("redacted_at", "updated_at")],
      ["legacy_runtime", aboutThePayment("TEXT")],
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
