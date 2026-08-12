import type { Table } from "#shared/db/migrations/schema/types.ts";
import { keyWords, wholeNumber } from "./columns.ts";

/** One durable operator-visible completion for an exact returned payment set. */
export const refundConfirmationTable: [name: string, table: Table] = [
  "refund_confirmations",
  {
    columns: [
      ["identity", keyWords()],
      ["attendee_id", wholeNumber()],
      ["created", "TEXT NOT NULL"],
    ],
  },
];
