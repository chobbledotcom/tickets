import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { paymentCompletionEffectsTable } from "#db/migrations/schema/payments/completion-effects.ts";
import { expectSchemaColumns } from "#test-utils/schema-columns.ts";
import { columnSql } from "./column-sql.ts";

const [, table] = paymentCompletionEffectsTable;

describe("the work done after a payment", () => {
  test("is one row per piece of work per payment", () => {
    expectSchemaColumns(
      paymentCompletionEffectsTable,
      "payment_completion_effects",
      ["id", "payment_id", "effect", "record_id", "completed_at"],
    );
  });

  test("only records work that has been done", () => {
    // Unlike a message waiting to be sent, a piece of work is written down
    // once it has happened, so its time is always there.
    expect(columnSql(table, "completed_at")).toBe("INTEGER NOT NULL");
  });

  test("may point at the row the work made, or at nothing yet", () => {
    expect(columnSql(table, "record_id")).toBe("INTEGER");
  });

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
