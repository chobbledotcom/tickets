import { withTransaction } from "#shared/db/client.ts";
import { CHECKOUT_STAGE_PAYMENT_FENCE_TRIGGERS } from "./schema/checkout-stage-triggers.ts";
import { ANSWER_AGGREGATE_TRIGGERS } from "./schema/triggers.ts";
import type { MigrationBuilder, SchemaRequirement } from "./types.ts";

const OLD_STRING_AGGREGATE_TRIGGER_NAMES = [
  "trg_attendee_answers_strings_insert",
  "trg_attendee_answers_strings_delete",
  "trg_attendee_answers_strings_update",
] as const;

const REPLACEMENT_TRIGGERS = [
  ...ANSWER_AGGREGATE_TRIGGERS,
  ...CHECKOUT_STAGE_PAYMENT_FENCE_TRIGGERS,
];

const requires: SchemaRequirement = {
  columns: {
    processed_payments: ["checkout_stage_attendee_id"],
  },
  triggers: REPLACEMENT_TRIGGERS.map((trigger) => trigger.name),
};

// Checkout-stage storage has been dormant since its schema shipped: no
// production path can have paired a stage with an older payment row. Existing
// payment sessions therefore keep NULL rather than inventing a stage claim.
const checkoutStagePaymentFencesMigration: MigrationBuilder = (context) =>
  context.additive({
    description:
      "Claim staged attendees when reserving payments and reject rollback-era mismatches.",
    id: "2026-07-16_checkout_stage_payment_fences",
    requires,
    up: async () => {
      await context.applySchemaChanges();
      await withTransaction(async (tx) => {
        for (const name of [
          ...ANSWER_AGGREGATE_TRIGGERS.map((trigger) => trigger.name),
          ...OLD_STRING_AGGREGATE_TRIGGER_NAMES,
        ]) {
          await tx.execute(`DROP TRIGGER IF EXISTS ${name}`);
        }
        for (const trigger of REPLACEMENT_TRIGGERS) {
          await tx.execute(trigger.sql);
        }
      });
    },
  });

export default checkoutStagePaymentFencesMigration;
