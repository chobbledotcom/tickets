import { TAX_STATE_KINDS } from "#shared/tax/transitions.ts";
import { attendeeIdColumn } from "./columns.ts";
import { checked, oneOf, text, wholeNumber } from "./scalar-columns.ts";
import type { Table } from "./types.ts";
import { sql } from "#db/sql.ts";

export const taxTables: [string, Table][] = [
  [
    "booking_tax_assessments",
    {
      columns: [
        ["booking_group", text],
        ["revision", checked(sql`revision >= 0`)(wholeNumber)],
        attendeeIdColumn,
        ["event_group", text],
        ["state", oneOf("state", TAX_STATE_KINDS)(text)],
        ["assessment", checked(sql`json_valid(assessment)`)(text)],
        ["occurred_at", text],
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
