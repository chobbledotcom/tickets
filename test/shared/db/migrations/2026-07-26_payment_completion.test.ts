import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import paymentCompletionMigration from "#shared/db/migrations/2026-07-26_payment_completion.ts";
import { context } from "./payment-aggregate-test-utils.ts";

test("declares durable payment effect receipts", () => {
  const migration = paymentCompletionMigration(context);

  expect({
    description: migration.description,
    id: migration.id,
    requires: migration.requires,
  }).toEqual({
    description:
      "Resume each payment completion effect and keep database effects idempotent.",
    id: "2026-07-26_payment_completion",
    requires: {
      columns: { built_sites: ["assignment_effect"] },
      indexes: [
        "idx_payment_completion_effects_unique",
        "idx_payment_completion_deliveries_unique",
        "idx_payment_completion_deliveries_pending",
        "idx_built_sites_assignment_effect",
      ],
      newTables: [
        "payment_completion_effects",
        "payment_completion_deliveries",
      ],
    },
  });
});
