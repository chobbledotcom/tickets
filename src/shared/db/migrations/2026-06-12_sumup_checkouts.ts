import { legacyPaymentSchemaMigration } from "./legacy-payment-schema.ts";

export default legacyPaymentSchemaMigration(
  "2026-06-12_sumup_checkouts",
  "Add encrypted sumup_checkouts staging table for SumUp metadata",
  {
    indexes: ["idx_sumup_checkouts_sumup_id"],
    newTables: ["sumup_checkouts"],
  },
);
