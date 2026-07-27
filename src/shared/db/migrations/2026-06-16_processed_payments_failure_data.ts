import { legacyPaymentSchemaMigration } from "./legacy-payment-schema.ts";

export default legacyPaymentSchemaMigration(
  "2026-06-16_processed_payments_failure_data",
  "Add failure_data to processed_payments so a handled payment failure (refund/sold-out/price-change) is recorded as a terminal outcome and replayed idempotently instead of leaving a stuck reservation",
  {
    columns: { processed_payments: ["failure_data"] },
  },
);
