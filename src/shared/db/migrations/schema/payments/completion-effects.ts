import type { Table } from "../types.ts";

export const paymentCompletionEffectsTable: [name: string, table: Table] = [
  "payment_completion_effects",
  {
    columns: [
      ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
      ["payment_id", "TEXT NOT NULL CHECK (length(trim(payment_id)) > 0)"],
      ["effect", "TEXT NOT NULL CHECK (length(trim(effect)) > 0)"],
      [
        "record_id",
        "INTEGER CHECK (record_id IS NULL OR (typeof(record_id) = 'integer' AND record_id >= 1))",
      ],
      [
        "completed_at",
        "INTEGER NOT NULL CHECK (typeof(completed_at) = 'integer' AND completed_at >= 0)",
      ],
    ],
    indexes: [
      {
        columns: ["payment_id", "effect"],
        name: "idx_payment_completion_effects_unique",
        unique: true,
      },
    ],
  },
];
