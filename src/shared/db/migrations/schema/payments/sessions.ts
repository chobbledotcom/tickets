/* jscpd:ignore-start -- imports */
import type { Table } from "../types.ts";
import {
  encryptedPaymentColumnOrNull,
  MAX_PAYMENT_INTEGER,
} from "./columns.ts";
/* jscpd:ignore-end */

export const paymentSessionTable: [name: string, table: Table] = [
  "payment_sessions",
  {
    columns: [
      ["id", "TEXT PRIMARY KEY CHECK (length(trim(id)) > 0)"],
      ["origin", "TEXT NOT NULL CHECK (origin IN ('current', 'legacy'))"],
      [
        "provider",
        "TEXT CHECK (provider IS NULL OR provider IN ('stripe', 'square', 'sumup'))",
      ],
      ["mode", "TEXT CHECK (mode IS NULL OR mode IN ('test', 'live'))"],
      [
        "account_id",
        "TEXT CHECK (account_id IS NULL OR length(trim(account_id)) > 0)",
      ],
      ["session_resource", "TEXT"],
      ["session_reference_index", "TEXT"],
      [
        "expected_amount",
        `INTEGER CHECK (expected_amount IS NULL OR (typeof(expected_amount) = 'integer' AND expected_amount BETWEEN 0 AND ${MAX_PAYMENT_INTEGER}))`,
      ],
      [
        "expected_currency",
        "TEXT CHECK (expected_currency IS NULL OR expected_currency GLOB '[A-Z][A-Z][A-Z]')",
      ],
      ["booking_intent", "TEXT"],
      ["checkout_create", "TEXT"],
      [
        "state",
        "TEXT NOT NULL CHECK (state IN ('created', 'pending', 'ready', 'processing', 'completed', 'failed', 'refunding', 'fully_refunded', 'needs_action'))",
      ],
      [
        "revision",
        "INTEGER NOT NULL DEFAULT 1 CHECK (typeof(revision) = 'integer' AND revision >= 1)",
      ],
      [
        "created_at",
        "INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)",
      ],
      [
        "updated_at",
        "INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= created_at)",
      ],
      ["lease_token", "TEXT"],
      [
        "lease_expires_at",
        "INTEGER CHECK (lease_expires_at IS NULL OR (typeof(lease_expires_at) = 'integer' AND lease_expires_at >= 0))",
      ],
      [
        "next_reconcile_at",
        "INTEGER CHECK (next_reconcile_at IS NULL OR (typeof(next_reconcile_at) = 'integer' AND next_reconcile_at >= 0))",
      ],
      [
        "attendee_id",
        "INTEGER CHECK (attendee_id IS NULL OR (typeof(attendee_id) = 'integer' AND attendee_id >= 1))",
      ],
      [
        "result_state",
        "TEXT NOT NULL DEFAULT 'none' CHECK (result_state IN ('none', 'succeeded', 'failed'))",
      ],
      ["result", "TEXT"],
      [
        "ticket_state",
        "TEXT NOT NULL DEFAULT 'none' CHECK (ticket_state IN ('none', 'ready', 'consumed'))",
      ],
      ["ticket_tokens", "TEXT"],
      [
        "completion_state",
        "TEXT NOT NULL DEFAULT 'none' CHECK (completion_state IN ('none', 'pending', 'completed', 'legacy_unknown'))",
      ],
      ["completion", "TEXT"],
      [
        "redacted_at",
        `INTEGER
          CHECK (redacted_at IS NULL OR (
            typeof(redacted_at) = 'integer' AND redacted_at >= updated_at
            AND lease_token IS NULL AND next_reconcile_at IS NULL
            AND ticket_state != 'ready'
            AND (
              (origin = 'current' AND (
                state = 'failed'
                OR (state IN ('completed', 'fully_refunded')
                  AND completion_state = 'completed')
              ))
              OR
              (origin = 'legacy' AND state IN ('completed', 'failed', 'fully_refunded'))
            )
          ))`,
      ],
      [
        "legacy_runtime",
        `TEXT
          CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
          CHECK ((session_resource IS NULL) = (session_reference_index IS NULL))
          CHECK (${encryptedPaymentColumnOrNull("session_resource")})
          CHECK (${encryptedPaymentColumnOrNull("booking_intent")})
          CHECK (${encryptedPaymentColumnOrNull("checkout_create")})
          CHECK (${encryptedPaymentColumnOrNull("result")})
          CHECK (${encryptedPaymentColumnOrNull("ticket_tokens")})
          CHECK (${encryptedPaymentColumnOrNull("completion")})
          CHECK (${encryptedPaymentColumnOrNull("legacy_runtime")})
          CHECK (
            (origin = 'legacy'
              AND legacy_runtime IS NOT NULL
              AND booking_intent IS NULL
              AND checkout_create IS NULL
              AND session_resource IS NULL
              AND session_reference_index IS NULL
              AND (
                (result_state = 'none' AND result IS NULL)
                OR (result_state = 'succeeded' AND result IS NULL AND state = 'completed')
                OR (result_state = 'failed' AND result IS NOT NULL AND state = 'failed')
              )
              AND ((ticket_state = 'ready') = (ticket_tokens IS NOT NULL))
              AND (completion_state IN ('none', 'legacy_unknown'))
              AND completion IS NULL
              AND (completion_state != 'legacy_unknown' OR state = 'completed'))
            OR
            (origin = 'current'
              AND provider IS NOT NULL
              AND mode IS NOT NULL
              AND account_id IS NOT NULL
              AND expected_amount IS NOT NULL
              AND expected_currency IS NOT NULL
              AND booking_intent IS NOT NULL
              AND (checkout_create IS NULL OR (session_resource IS NULL AND state = 'created'))
              AND (session_resource IS NOT NULL OR state IN ('created', 'failed'))
              AND ((result_state = 'none') = (result IS NULL))
              AND ((ticket_state = 'ready') = (ticket_tokens IS NOT NULL))
              AND ((completion_state = 'none') = (completion IS NULL))
              AND (completion_state != 'pending' OR next_reconcile_at IS NOT NULL)
              AND completion_state != 'legacy_unknown')
          )`,
      ],
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
