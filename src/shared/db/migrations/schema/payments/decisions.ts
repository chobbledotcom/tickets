import type { Table } from "../types.ts";

export const paymentCaseDecisionTable: [name: string, table: Table] = [
  "payment_case_decisions",
  {
    columns: [
      ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
      [
        "case_id",
        "INTEGER NOT NULL CHECK (typeof(case_id) = 'integer' AND case_id >= 1)",
      ],
      [
        "case_revision",
        "INTEGER NOT NULL CHECK (typeof(case_revision) = 'integer' AND case_revision >= 1)",
      ],
      ["claim", "TEXT NOT NULL CHECK (claim LIKE 'enc:1:%')"],
      ["decision", "TEXT CHECK (decision IS NULL OR decision LIKE 'enc:1:%')"],
      [
        "state",
        "TEXT NOT NULL CHECK (state IN ('accepted', 'running', 'retrying', 'completed'))",
      ],
      [
        "attempt_count",
        "INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempt_count) = 'integer' AND attempt_count >= 0)",
      ],
      [
        "created_at",
        "INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)",
      ],
      [
        "last_attempt_at",
        "INTEGER CHECK (last_attempt_at IS NULL OR (typeof(last_attempt_at) = 'integer' AND last_attempt_at >= created_at))",
      ],
      [
        "next_retry_at",
        "INTEGER CHECK (next_retry_at IS NULL OR (typeof(next_retry_at) = 'integer' AND next_retry_at >= created_at))",
      ],
      [
        "last_error",
        `TEXT
          CHECK (last_error IS NULL OR last_error LIKE 'enc:1:%')
          CHECK ((state = 'retrying') = (next_retry_at IS NOT NULL))
          CHECK ((state = 'retrying') = (last_error IS NOT NULL))
          CHECK ((attempt_count = 0) = (last_attempt_at IS NULL))
          CHECK (decision IS NOT NULL OR state IN ('accepted', 'running', 'retrying'))`,
      ],
    ],
    indexes: [
      {
        columns: ["case_id", "case_revision"],
        name: "idx_payment_case_decisions_revision",
        unique: true,
      },
      {
        columns: ["state", "next_retry_at", "id"],
        name: "idx_payment_case_decisions_retry",
      },
    ],
  },
];
