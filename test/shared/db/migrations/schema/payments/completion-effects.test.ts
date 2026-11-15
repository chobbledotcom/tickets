import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { paymentCompletionEffectsTable } from "#db/migrations/schema/payments/completion-effects.ts";
import { testColumnSql } from "#test-utils/schema-column-cases.ts";
import { expectSchemaColumns } from "#test-utils/schema-columns.ts";

const [, table] = paymentCompletionEffectsTable;

describe("the work done after a payment", () => {
  test("is one row per piece of work per payment", () => {
    expectSchemaColumns(
      paymentCompletionEffectsTable,
      "payment_completion_effects",
      ["id", "payment_id", "effect", "record_id", "completed_at"],
    );
  });

  // Unlike a message waiting to be sent, a piece of work is written down
  // once it has happened, so its time is always there.
  testColumnSql(table, [
    [
      "only records work that has been done",
      "completed_at",
      "INTEGER NOT NULL",
    ],
    [
      "may point at the row the work made, or at nothing yet",
      "record_id",
      "INTEGER",
    ],
  ]);

  test("cannot do the same piece of work for a payment twice", () => {
    // This is what stops a retry booking a second ticket for one payment.
    expect(table.indexes).toEqual([
      {
        columns: ["payment_id", "effect"],
        name: "idx_payment_completion_effects_unique",
        unique: true,
      },
    ]);
  });
});
