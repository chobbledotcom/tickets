/* jscpd:ignore-start -- imports */
import type { Table } from "#shared/db/migrations/schema/types.ts";
import {
  encryptedPaymentColumnOrNull,
  MAX_PAYMENT_INTEGER,
} from "./columns.ts";
/* jscpd:ignore-end */

export const paymentChargeTable: [name: string, table: Table] = [
  "payment_charges",
  {
    columns: [
      ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
      ["payment_id", "TEXT NOT NULL CHECK (length(trim(payment_id)) > 0)"],
      [
        "origin",
        "TEXT NOT NULL DEFAULT 'current' CHECK (origin IN ('current', 'legacy'))",
      ],
      [
        "provider",
        "TEXT CHECK (provider IS NULL OR provider IN ('stripe', 'square', 'sumup'))",
      ],
      [
        "resource_kind",
        "TEXT CHECK (resource_kind IS NULL OR resource_kind IN ('stripe_payment_intent', 'square_payment', 'sumup_transaction'))",
      ],
      [
        "provider_reference",
        "TEXT NOT NULL CHECK (length(provider_reference) > 0)",
      ],
      [
        "reference_index",
        "TEXT CHECK (reference_index IS NULL OR length(reference_index) > 0)",
      ],
      [
        "captured_amount",
        `INTEGER CHECK (captured_amount IS NULL OR (typeof(captured_amount) = 'integer' AND captured_amount BETWEEN 1 AND ${MAX_PAYMENT_INTEGER}))`,
      ],
      [
        "currency",
        "TEXT CHECK (currency IS NULL OR currency GLOB '[A-Z][A-Z][A-Z]')",
      ],
      [
        "refunded_amount",
        "INTEGER CHECK (refunded_amount IS NULL OR (typeof(refunded_amount) = 'integer' AND refunded_amount >= 0))",
      ],
      [
        "refund_state",
        "TEXT NOT NULL DEFAULT 'none' CHECK (refund_state IN ('none', 'requested', 'pending', 'partial', 'completed', 'failed', 'unknown'))",
      ],
      ["pending_refund_id", "TEXT"],
      [
        "pending_refund_index",
        "TEXT CHECK (pending_refund_index IS NULL OR length(pending_refund_index) > 0)",
      ],
      ["pending_refund_idempotency_key", "TEXT"],
      [
        "pending_refund_key_index",
        "TEXT CHECK (pending_refund_key_index IS NULL OR length(pending_refund_key_index) > 0)",
      ],
      // A time, like every other time here, so it can be compared with them.
      // SQLite sorts numbers before text whatever they say, so one time kept
      // as words would always read as later than one kept as a number.
      [
        "provider_refunded_at",
        "INTEGER CHECK (provider_refunded_at IS NULL OR (typeof(provider_refunded_at) = 'integer' AND provider_refunded_at >= 0))",
      ],
      ["legacy_source", "TEXT"],
      [
        "created_at",
        "INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)",
      ],
      [
        "updated_at",
        "INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= created_at)",
      ],
      [
        "observed_at",
        `INTEGER NOT NULL
          CHECK (typeof(observed_at) = 'integer' AND observed_at >= 0)
          CHECK (
            (origin = 'current'
              AND legacy_source IS NULL
              AND provider_refunded_at IS NULL
              AND provider_reference GLOB 'enc:1:*'
              AND reference_index IS NOT NULL
              AND captured_amount IS NOT NULL
              AND currency IS NOT NULL
              AND refunded_amount IS NOT NULL
              AND refunded_amount BETWEEN 0 AND captured_amount
              AND refund_state != 'unknown'
              AND provider IS NOT NULL
              AND resource_kind IS NOT NULL
              AND (
                (provider = 'stripe' AND resource_kind = 'stripe_payment_intent')
                OR (provider = 'square' AND resource_kind = 'square_payment')
                OR (provider = 'sumup' AND resource_kind = 'sumup_transaction')
              )
              AND (
                (refund_state = 'requested' AND pending_refund_id IS NULL AND pending_refund_idempotency_key IS NOT NULL)
                OR refund_state = 'pending'
                OR (refund_state = 'failed' AND pending_refund_id IS NULL)
                OR (refund_state IN ('none', 'partial', 'completed') AND pending_refund_id IS NULL AND pending_refund_idempotency_key IS NULL)
              )
              AND (refund_state NOT IN ('requested', 'pending') OR refunded_amount < captured_amount)
              AND (refund_state != 'none' OR refunded_amount = 0)
              AND (refund_state != 'partial' OR (refunded_amount > 0 AND refunded_amount < captured_amount))
              AND (refund_state != 'completed' OR refunded_amount = captured_amount))
            OR
            (origin = 'legacy'
              AND provider IS NULL
              AND resource_kind IS NULL
              AND provider_reference GLOB 'hyb:1:*'
              AND reference_index IS NULL
              AND captured_amount IS NULL
              AND currency IS NULL
              AND refunded_amount IS NULL
              AND refund_state = 'unknown'
              AND pending_refund_id IS NULL
              AND pending_refund_index IS NULL
              AND pending_refund_idempotency_key IS NULL
              AND pending_refund_key_index IS NULL
              AND legacy_source IS NOT NULL
              AND legacy_source IN ('processed_payments', 'attendees.pii_blob', 'attendee_merge'))
          )
          CHECK ((pending_refund_id IS NULL) = (pending_refund_index IS NULL))
          CHECK ((pending_refund_idempotency_key IS NULL) = (pending_refund_key_index IS NULL))
          CHECK (${encryptedPaymentColumnOrNull("pending_refund_id")})
          CHECK (${encryptedPaymentColumnOrNull(
            "pending_refund_idempotency_key",
          )})`,
      ],
    ],
    indexes: [
      {
        columns: ["payment_id", "reference_index"],
        name: "idx_payment_charges_payment_reference",
        unique: true,
      },
      {
        columns: ["reference_index"],
        name: "idx_payment_charges_reference",
      },
      {
        columns: ["pending_refund_index"],
        name: "idx_payment_charges_pending_refund",
      },
      {
        columns: ["payment_id", "legacy_source"],
        name: "idx_payment_charges_legacy_source",
        unique: true,
      },
    ],
  },
];
