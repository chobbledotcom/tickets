import type { Table } from "#shared/db/migrations/schema/types.ts";

export const paymentCaseTable: [name: string, table: Table] = [
  "payment_cases",
  {
    columns: [
      ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
      ["payment_id", "TEXT NOT NULL CHECK (length(trim(payment_id)) > 0)"],
      ["resource", "TEXT NOT NULL CHECK (resource LIKE 'enc:1:%')"],
      ["resource_index", "TEXT NOT NULL CHECK (length(resource_index) > 0)"],
      ["reason", "TEXT NOT NULL CHECK (length(trim(reason)) > 0)"],
      [
        "state",
        "TEXT NOT NULL CHECK (state IN ('retrying', 'needs_action', 'resolved'))",
      ],
      [
        "first_observed_at",
        "INTEGER NOT NULL CHECK (typeof(first_observed_at) = 'integer' AND first_observed_at >= 0)",
      ],
      [
        "last_observed_at",
        "INTEGER NOT NULL CHECK (typeof(last_observed_at) = 'integer' AND last_observed_at >= first_observed_at)",
      ],
      [
        "next_reconcile_at",
        "INTEGER CHECK (next_reconcile_at IS NULL OR (typeof(next_reconcile_at) = 'integer' AND next_reconcile_at >= 0))",
      ],
      [
        "consecutive_count",
        "INTEGER NOT NULL CHECK (typeof(consecutive_count) = 'integer' AND consecutive_count >= 1)",
      ],
      [
        "alerted_at",
        "INTEGER CHECK (alerted_at IS NULL OR (typeof(alerted_at) = 'integer' AND alerted_at >= 0))",
      ],
      [
        "alerted_revision",
        "INTEGER CHECK (alerted_revision IS NULL OR (typeof(alerted_revision) = 'integer' AND alerted_revision >= 1))",
      ],
      [
        "alert_sent_at",
        "INTEGER CHECK (alert_sent_at IS NULL OR (typeof(alert_sent_at) = 'integer' AND alert_sent_at >= 0))",
      ],
      [
        "alert_sent_revision",
        "INTEGER CHECK (alert_sent_revision IS NULL OR (typeof(alert_sent_revision) = 'integer' AND alert_sent_revision >= 1))",
      ],
      ["alert_lease_token", "TEXT"],
      [
        "alert_lease_expires_at",
        "INTEGER CHECK (alert_lease_expires_at IS NULL OR (typeof(alert_lease_expires_at) = 'integer' AND alert_lease_expires_at >= 0))",
      ],
      ["evidence", "TEXT NOT NULL CHECK (evidence LIKE 'enc:1:%')"],
      [
        "evidence_redacted_at",
        "INTEGER CHECK (evidence_redacted_at IS NULL OR (state = 'resolved' AND typeof(evidence_redacted_at) = 'integer' AND evidence_redacted_at >= resolved_at))",
      ],
      [
        "revision",
        "INTEGER NOT NULL DEFAULT 1 CHECK (typeof(revision) = 'integer' AND revision >= 1)",
      ],
      [
        "resolved_at",
        `INTEGER
          CHECK (resolved_at IS NULL OR (typeof(resolved_at) = 'integer' AND resolved_at >= last_observed_at))
          CHECK ((alerted_at IS NULL) = (alerted_revision IS NULL))
          CHECK (alerted_revision IS NULL OR alerted_revision <= revision)
          CHECK ((alert_sent_at IS NULL) = (alert_sent_revision IS NULL))
          CHECK (alert_sent_revision IS NULL OR (alerted_revision IS NOT NULL AND alert_sent_revision = alerted_revision))
          CHECK ((alert_lease_token IS NULL) = (alert_lease_expires_at IS NULL))
          CHECK (alert_lease_expires_at IS NULL OR (typeof(alert_lease_expires_at) = 'integer' AND alert_lease_expires_at >= 0))
          CHECK (alert_lease_token IS NULL OR (state = 'needs_action' AND alert_sent_revision IS NULL))
          CHECK (
            (state = 'retrying' AND next_reconcile_at IS NOT NULL AND resolved_at IS NULL AND alerted_at IS NULL)
            OR (state = 'needs_action' AND next_reconcile_at IS NULL AND resolved_at IS NULL AND alerted_at IS NOT NULL)
            OR (state = 'resolved' AND next_reconcile_at IS NULL AND resolved_at IS NOT NULL)
          )`,
      ],
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
  },
];
