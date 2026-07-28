import type { Table } from "#shared/db/migrations/schema/types.ts";

export const paymentCompletionDeliveriesTable: [name: string, table: Table] = [
  "payment_completion_deliveries",
  {
    columns: [
      ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
      ["payment_id", "TEXT NOT NULL CHECK (length(trim(payment_id)) > 0)"],
      ["delivery_key", "TEXT NOT NULL CHECK (length(trim(delivery_key)) > 0)"],
      // The message carries the buyer's name, email, phone and address, so the
      // table demands it be encrypted rather than trusting every writer to.
      [
        "data",
        "TEXT NOT NULL CHECK (length(trim(data)) > 0 AND data LIKE 'enc:1:%')",
      ],
      [
        "completed_at",
        "INTEGER CHECK (completed_at IS NULL OR (typeof(completed_at) = 'integer' AND completed_at >= 0))",
      ],
    ],
    indexes: [
      {
        columns: ["payment_id", "delivery_key"],
        name: "idx_payment_completion_deliveries_unique",
        unique: true,
      },
      {
        columns: ["payment_id", "completed_at", "id"],
        name: "idx_payment_completion_deliveries_pending",
      },
    ],
  },
];
