import type { Table } from "#db/migrations/schema/types.ts";
import { keyWords, wholeNumber, words } from "./columns.ts";

/** One durable operator-visible completion for an exact returned payment set. */
export const refundConfirmationTable: [name: string, table: Table] = [
  "refund_confirmations",
  {
    columns: [
      ["identity", keyWords()],
      ["attendee_id", wholeNumber()],
      ["created", "TEXT NOT NULL"],
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
      ["confirmation_identity", words()],
      ["reference_index", words()],
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
