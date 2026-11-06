import {
  requiredTextKey,
  text,
  wholeNumber,
} from "#db/migrations/schema/scalar-columns.ts";
import type { Table } from "#db/migrations/schema/types.ts";

/** One durable operator-visible completion for an exact returned payment set. */
export const refundConfirmationTable: [name: string, table: Table] = [
  "refund_confirmations",
  {
    columns: [
      ["identity", requiredTextKey],
      ["attendee_id", wholeNumber],
      ["created", text],
    ],
    indexes: [
      {
        columns: ["attendee_id"],
        name: "idx_refund_confirmations_attendee",
      },
    ],
  },
];

/** The queryable members of each exact returned payment set. */
export const refundConfirmationReferenceTable: [name: string, table: Table] = [
  "refund_confirmation_references",
  {
    columns: [
      ["confirmation_identity", text],
      ["reference_index", text],
    ],
    indexes: [
      {
        columns: ["confirmation_identity", "reference_index"],
        name: "idx_refund_confirmation_references_unique",
        unique: true,
      },
    ],
  },
];
