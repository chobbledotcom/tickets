/* jscpd:ignore-start -- imports */
import {
  text,
  wholeNumber,
  wholeNumberOrNull,
} from "#db/migrations/schema/scalar-columns.ts";
import { paymentRecord } from "./columns.ts";
/* jscpd:ignore-end */

export const paymentCompletionEffectsTable = paymentRecord(
  "payment_completion_effects",
  {
    columns: [
      ["effect", text],
      ["record_id", wholeNumberOrNull],
      ["completed_at", wholeNumber],
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
