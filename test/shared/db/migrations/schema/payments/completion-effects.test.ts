import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { paymentCompletionEffectsTable } from "#db/migrations/schema/payments/completion-effects.ts";

const [name, table] = paymentCompletionEffectsTable;
const column = (wanted: string): string =>
  table.columns.find(([held]) => held === wanted)?.[1] ?? "";

describe("the work done after a payment", () => {
  test("is one row per piece of work per payment", () => {
    expect(name).toBe("payment_completion_effects");
    expect(table.columns.map(([held]) => held)).toEqual([
      "id",
      "payment_id",
      "effect",
      "record_id",
      "completed_at",
    ]);
  });

  test("only records work that has been done", () => {
    // Unlike a message waiting to be sent, a piece of work is written down
    // once it has happened, so its time is always there.
    expect(column("completed_at")).toBe("INTEGER NOT NULL");
  });

  test("may point at the row the work made, or at nothing yet", () => {
    expect(column("record_id")).toBe("INTEGER");
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
