import { schemaMigration } from "./define.ts";
import { CHECKOUT_STAGE_PAYMENT_FENCE_TRIGGERS } from "./schema/checkout-stage-triggers.ts";
import { ANSWER_AGGREGATE_TRIGGERS } from "./schema/triggers.ts";

// Checkout-stage storage has been dormant since its schema shipped: no
// production path can have paired a stage with an older payment row. Existing
// payment sessions therefore keep NULL rather than inventing a stage claim.
export default schemaMigration(
  "2026-07-16_checkout_stage_payment_fences",
  "Claim staged attendees when reserving payments and reject rollback-era mismatches.",
  {
    columns: {
      processed_payments: ["checkout_stage_attendee_id"],
    },
    triggers: CHECKOUT_STAGE_PAYMENT_FENCE_TRIGGERS.map(
      (trigger) => trigger.name,
    ),
  },
  async ({ getDb, syncTriggers }) => {
    await getDb().executeMultiple(
      ANSWER_AGGREGATE_TRIGGERS.map(
        (trigger) => `DROP TRIGGER IF EXISTS ${trigger.name}`,
      ).join(";\n"),
    );
    await syncTriggers();
  },
);
