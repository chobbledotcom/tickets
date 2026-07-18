import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import migrationDefinition from "#shared/db/migrations/2026-07-18_checkout_stage_refund_spec.ts";
import {
  applySchemaChanges,
  syncIndexes,
} from "#shared/db/migrations/schema-sync.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

test("the checkout refund migration declares its exact schema change", () => {
  const migration = migrationDefinition(
    buildMigrationContext({ applySchemaChanges, syncIndexes }),
  );
  expect({
    description: migration.description,
    id: migration.id,
    requires: migration.requires,
  }).toEqual({
    description:
      "Keep the original reason while a checkout refund is still processing.",
    id: "2026-07-18_checkout_stage_refund_spec",
    requires: { columns: { checkout_stages: ["refund_spec"] } },
  });
});
