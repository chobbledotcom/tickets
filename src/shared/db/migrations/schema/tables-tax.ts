import type { Table } from "./types.ts";

export const taxTables: [string, Table][] = [
  [
    "booking_tax_assessments",
    {
      columns: [
        ["booking_group", "TEXT NOT NULL"],
        ["revision", "INTEGER NOT NULL CHECK (revision >= 0)"],
        ["attendee_id", "INTEGER NOT NULL"],
        ["event_group", "TEXT NOT NULL"],
        ["state", "TEXT NOT NULL CHECK (state IN ('active', 'refunded'))"],
        ["assessment", "TEXT NOT NULL CHECK (json_valid(assessment))"],
        ["occurred_at", "TEXT NOT NULL"],
      ],
      indexes: [
        {
          columns: ["booking_group", "revision"],
          name: "idx_booking_tax_assessments_revision",
          unique: true,
        },
        {
          columns: ["event_group"],
          name: "idx_booking_tax_assessments_event",
          unique: true,
        },
        {
          columns: ["attendee_id", "booking_group", "revision"],
          name: "idx_booking_tax_assessments_attendee",
        },
      ],
    },
  ],
];
