import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import paymentCompletionMigration from "#shared/db/migrations/2026-07-26_payment_completion.ts";
import { context } from "./payment-aggregate-test-utils.ts";

test("declares only the mark a built site carries", () => {
  const migration = paymentCompletionMigration(context);

  expect({
    description: migration.description,
    id: migration.id,
    requires: migration.requires,
  }).toEqual({
    description:
      "Remember which handing-over a built site is part of, so a retry resumes it.",
    id: "2026-07-26_payment_completion",
    // The payment tables it once made are now made by
    // 2026-07-26_payment_records, so only the built-site mark is left.
    requires: {
      columns: { built_sites: ["assignment_effect"] },
      indexes: ["idx_built_sites_assignment_effect"],
    },
  });
});
