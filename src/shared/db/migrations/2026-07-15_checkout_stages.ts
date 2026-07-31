import { legacyPaymentSchemaMigration } from "./legacy-payment-schema.ts";

export default legacyPaymentSchemaMigration(
  "2026-07-15_checkout_stages",
  "Add dormant checkout stage storage.",
  {
    indexes: [
      "idx_checkout_stages_attendee_id",
      "idx_checkout_stages_state_created_at",
    ],
    newTables: ["checkout_stages"],
  },
);
