import {
  paymentRecord,
  wholeNumber,
  wholeNumberOrNull,
  words,
} from "./columns.ts";

export const paymentCompletionEffectsTable = paymentRecord(
  "payment_completion_effects",
  {
    columns: [
      ["effect", words()],
      ["record_id", wholeNumberOrNull()],
      ["completed_at", wholeNumber()],
    ],
    indexes: [
      {
        columns: ["payment_id", "effect"],
        name: "idx_payment_completion_effects_unique",
        unique: true,
      },
    ],
  },
);
