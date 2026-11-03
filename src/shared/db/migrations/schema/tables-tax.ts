/* jscpd:ignore-start -- imports */
import { checked, text, wholeNumber } from "./scalar-columns.ts";
import type { Table } from "./types.ts";
/* jscpd:ignore-end */

export const taxTables: [string, Table][] = [
  [
    "booking_tax_assessments",
    {
      columns: [
        ["booking_group", text],
        ["revision", checked("revision >= 0")(wholeNumber)],
        ["attendee_id", wholeNumber],
        ["event_group", text],
        ["state", checked("state IN ('active', 'refunded')")(text)],
        ["assessment", checked("json_valid(assessment)")(text)],
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
