import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-07-26_payment_completion",
  "Resume each payment completion effect and keep database effects idempotent.",
  {
    columns: { built_sites: ["assignment_effect"] },
    indexes: [
      "idx_payment_completion_effects_unique",
      "idx_payment_completion_deliveries_unique",
      "idx_payment_completion_deliveries_pending",
      "idx_built_sites_assignment_effect",
    ],
    newTables: ["payment_completion_effects", "payment_completion_deliveries"],
  },
);
