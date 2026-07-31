import { legacyPaymentSchemaMigration } from "./legacy-payment-schema.ts";

export default legacyPaymentSchemaMigration(
  "2026-07-07_processed_payments_payment_reference",
  "Store encrypted provider payment references on processed_payments so every captured charge can be refunded.",
  {
    columns: {
      processed_payments: ["payment_reference", "provider_refunded_at"],
    },
  },
);
