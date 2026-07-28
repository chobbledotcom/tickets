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
      ["effect", words("effect")],
      ["record_id", wholeNumberOrNull("record_id", 1)],
      ["completed_at", wholeNumber("completed_at")],
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
