import {
  text,
  wholeNumberOrNull,
} from "#db/migrations/schema/scalar-columns.ts";
import { ownerEncryptedColumn, paymentRecord } from "./columns.ts";

export const paymentCompletionDeliveriesTable = paymentRecord(
  "payment_completion_deliveries",
  {
    columns: [
      ["delivery_key", text],
      // The message carries the buyer's name, email, phone and address, so the
      // table demands it be hidden rather than trusting every writer to.
      ownerEncryptedColumn("data"),
      ["completed_at", wholeNumberOrNull],
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
);
