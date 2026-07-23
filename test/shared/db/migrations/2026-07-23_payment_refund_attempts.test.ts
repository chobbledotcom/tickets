import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import migrationDefinition from "#shared/db/migrations/2026-07-23_payment_refund_attempts.ts";
import { applySchemaChanges } from "#shared/db/migrations/schema-sync.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

test("the payment refund attempt migration declares its exact table", () => {
  const migration = migrationDefinition(
    buildMigrationContext({ applySchemaChanges }),
  );
  expect({
    description: migration.description,
    id: migration.id,
    requires: migration.requires,
  }).toEqual({
    description:
      "Keep non-idempotent refund submissions from being sent twice.",
    id: "2026-07-23_payment_refund_attempts",
    requires: { newTables: ["payment_refund_attempts"] },
  });
});
